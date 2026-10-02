#!/usr/bin/env node
// Witness engine for the harness self-check. NOT the engine, not a design for
// it and not a contract: the contract is the acceptance tests and SEAM.md.
//
// It exists for the reason witness-schema.sql does. The slice-2 acceptance
// tests were written before the engine they test, so running them could not
// show they are right. This single-file stand-in does what SEAM.md §§12–18
// ask (with the amendments of §§22 and 23, made after the two slice-2
// reviews), as plainly as it can, so that the self-check can show two things:
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
import { execFile } from 'node:child_process';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { newId } from '../ids.mjs';
import { WORK, isLegal, m1Kinds } from '../transitions.mjs';
import { makeGit, pathViolation, sha256 } from './witness-git.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(here, '..', '..', 'contract', 'config.json'), 'utf8'));
const ENGINE_MIGRATIONS = join(here, '..', '..', '..', '..', 'migrations');

const MUTANT = process.env.WITNESS_MUTANT ?? '';
const mutant = (name) => MUTANT === name;
// Three defects written for the slice-2 cases are defects of an engine whose
// only way to end a run after a failed attempt is the expiry of its lease:
// with them, the engine does not retry a failed end itself either.
const NO_RETRY = ['expired_lease_not_reconciled', 'heartbeat_renews_after_end_decided', 'expiry_forgets_decided_end'].includes(MUTANT);
// The same defect in an engine that does retry: `heartbeat_renews_while_retrying`.
const heartbeatRenewsAfterDecided = () => mutant('heartbeat_renews_after_end_decided') || mutant('heartbeat_renews_while_retrying');

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
const DEFAULT_POLICY = {};
for (const [key, spec] of Object.entries(CONTRACT.project)) if (!key.startsWith('$')) DEFAULT_POLICY[key] = spec.default;

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

// The defect `token_space_accepted`: a space or a tab inside the token is let through.
const TOKEN_FORM = process.env.WITNESS_MUTANT === 'token_space_accepted' ? /^[\x21-\x7e][\x20-\x7e\t]{30,}[\x21-\x7e]$/ : /^[\x21-\x7e]{32,}$/;
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
    db.exec(readFileSync(join(here, 'witness-slice3.sql'), 'utf8'));
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
const refusal = (status, code, reason, subject = {}, whatToDo) => Object.assign(new Error(reason), { status, code, subject, whatToDo });

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

function park(id, reason, question) {
  transition(id, 'parked');
  const item = one('SELECT * FROM "work_items" WHERE "id" = ?', id);
  const decision = raiseDecision(item.project, 'blocker', 'work_item', id, ['retry', 'cancel'], question ?? `Work item parked: ${reason}.`, [id]);
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
// Engine git (witness-git.mjs): every call names its repository, gets a
// constructed environment and a deadline, and runs nothing the repository
// configures (SEAM.md §§16, 31).
const G = makeGit({ home, cfg, mutant });
const git = (repo, args, opts = {}) => G.run(G.repoDir(repo), args, { filters: true, ...opts });

// The effective policy of a project: the schema defaults under what the
// engine has recorded for it (SEAM.md §27). Never what a file in the
// repository says.
const policyOf = (projectId) => ({ ...DEFAULT_POLICY, ...json(one('SELECT "policy" FROM "projects" WHERE "id" = ?', projectId)?.policy ?? '{}') });

// The journal of one worktree effect of a run, in two steps that can each be
// repeated (E28 item 1). The intent is recorded once per run and kind: a
// repeated intent finds the operation it recorded before. The settle writes
// the journal's remaining events and the operation's status once.
const journalKey = (kind, runId) => createHash('sha256').update(`${kind}:${runId}`).digest('hex');
function journalIntend(project, runId, kind) {
  const key = journalKey(kind, runId);
  const existing = one('SELECT * FROM "operations" WHERE "idempotency_key" = ?', key);
  // The defect `remove_settle_not_repeatable`: a repeated intent records the operation again.
  if (existing && !(mutant('remove_settle_not_repeatable') && kind === 'worktree_remove')) return existing.id;
  const op = newId('op_');
  insert('operations', {
    id: op,
    created_at: iso(),
    project,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "operations" WHERE "project" = ?', project).n,
    kind: 'git_worktree',
    target: '{}',
    subject: '{}',
    idempotency_key: key,
    semantic_generation: 1,
    status: 'intended',
    deadline_at: iso(now() + 60_000),
  });
  emit('operation.intended', { operation: op, project, run: runId });
  insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: op, seq: 1, journal_kind: kind, event_kind: 'intended', payload: JSON.stringify({ repo: 'dev', run: runId }) });
  emit('git.journal_intended', { operation: op, project, run: runId });
  return op;
}
function journalSettle(project, runId, kind, op, eventKinds = ['applied', 'confirmed', 'finalized'], status = 'succeeded') {
  if (one('SELECT "status" FROM "operations" WHERE "id" = ?', op).status !== 'intended') return;
  eventKinds.forEach((eventKind, i) => {
    insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: op, seq: i + 2, journal_kind: kind, event_kind: eventKind, payload: JSON.stringify({ repo: 'dev', run: runId }) });
    if (eventKind !== 'failed') emit(`git.journal_${eventKind}`, { operation: op, project, run: runId });
  });
  exec('UPDATE "operations" SET "status" = ?, "finalized_at" = ? WHERE "id" = ?', status, status === 'succeeded' ? iso() : null, op);
  emit(`operation.${status}`, { operation: op, project, run: runId });
  if (status === 'succeeded') emit('operation.finalized', { operation: op, project, run: runId });
}

function selectWork(project) {
  if (project.paused && !mutant('paused_dispatches')) return null;
  if (project.registration_state !== 'registered') return null;
  // The defect `oob_not_blocking`: work goes on over an unreconciled out-of-band change.
  if (projectBlocked(project) && !mutant('oob_not_blocking')) return null;
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
  let base;
  try {
    base = git(project.dev_repo_path, ['rev-parse', `refs/heads/${project.integration_branch}`]);
  } catch {
    return; // the repository cannot be read: nothing is dispatched
  }
  // Work that was checkpointed continues from its checkpoint, in a new run linked to the one that made it.
  // The defect `continuation_from_base`: it starts over from the branch.
  let continues = null;
  if (item.checkpoint_run && !mutant('continuation_from_base')) {
    continues = item.checkpoint_run;
    base = one('SELECT "current_base" FROM "workspaces" WHERE "run" = ?', continues).current_base;
  }
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
      deadline_at: iso(now() + policyOf(item.project)[`deadline_${role}`] * 1000),
      parent_run: continues ?? (prior && ['stopped', 'timed_out', 'recovered'].includes(prior.outcome) && !mutant('no_parent_link') ? prior.id : null),
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

  // D1 §15.1: an unqualified backend is refused before anything is prepared or spawned.
  if (!qualified()) {
    live.get(id).spawned = false;
    return void endRun(id, 'refused', 'preflight_refused');
  }

  const workspace = join(home, 'workspaces', id);
  mkdirSync(join(home, 'workspaces'), { recursive: true });
  let op;
  tx(() => {
    op = journalIntend(item.project, id, 'worktree_add');
  });
  const failAdd = () => {
    tx(() => journalSettle(item.project, id, 'worktree_add', op, ['failed'], 'failed'));
    live.get(id).spawned = false;
    return void endRun(id, 'failed', 'infra_error');
  };
  // Whatever is already at the path is not the engine's: a symbolic link in
  // particular is refused (SEAM.md §35). The defect `symlink_workspace_adopted`
  // goes on, and takes a failed `worktree add` for a worktree that is there
  // because the path, resolved, is one the repository lists.
  let occupied = false;
  try {
    lstatSync(workspace);
    occupied = true;
  } catch {
    // free
  }
  if (occupied && !mutant('symlink_workspace_adopted')) return failAdd();
  const added = await addWorktree(project.dev_repo_path, workspace, base);
  if (added === 'ambiguous') {
    // The command could have written and was killed at its deadline: the
    // operation is ambiguous, and nothing goes on because a timer ran out.
    tx(() => journalSettle(item.project, id, 'worktree_add', op, ['ambiguous'], 'ambiguous'));
    live.get(id).spawned = false;
    return;
  }
  if (added === 'failed') {
    const present = mutant('symlink_workspace_adopted') && G.worktrees(project.dev_repo_path).some((w) => G.real(w.path) === G.real(workspace));
    if (!present) return failAdd();
  }
  if (mutant('worktree_probe_literal_path')) {
    // The defect: the probe looks for the path as given in a list that git
    // prints with symbolic links resolved, and takes a miss for "not added".
    const listed = git(project.dev_repo_path, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${workspace}`);
    if (!listed) return failAdd();
  }
  let baseline = null;
  try {
    baseline = JSON.stringify(G.checkoutBaseline(workspace));
    live.get(id).meta = G.metadataOf(project.dev_repo_path, workspace);
  } catch {
    // only reached with a defect switched on
  }
  tx(() => {
    journalSettle(item.project, id, 'worktree_add', op);
    const ws = newId('ws_');
    insert('workspaces', { id: ws, created_at: iso(), project: item.project, run: id, path: workspace, base_revision: base, current_base: base, disposition: 'active' });
    exec('UPDATE "runs" SET "workspace" = ? WHERE "id" = ?', ws, id);
    if (baseline) insert('managed_checkouts', { id: newId('mc_'), created_at: iso(), project: item.project, kind: 'run_workspace', path: workspace, baseline, owner_run: id });
    appendStatus(item.project, receipt, 'dispatch_started');
  });
  // The spawn is not waited for by the tick.
  launch(id, { receipt, domain, workspace, role }).catch((err) => process.stderr.write(`launch ${id}: ${err.stack}\n`));
}

// `git worktree add`, not waited for synchronously, with the git deadline
// (D1 §7.1): 'added', 'failed', or 'ambiguous' when the command was killed
// at its deadline and may have written.
function addWorktree(repo, workspace, base) {
  let args = [];
  try {
    args = G.argv(G.repoDir(repo), ['worktree', 'add', '--detach', workspace, base], { filters: true });
  } catch {
    return Promise.resolve('failed');
  }
  return new Promise((resolve) => {
    const options = { env: G.env(), ...(mutant('git_no_deadline') ? {} : { timeout: cfg.git_deadline * 1000, killSignal: 'SIGKILL' }) };
    execFile('git', args, options, (err) => {
      if (!err) return resolve('added');
      // The defect `timeout_is_absent`: a command killed at its deadline is taken to have done nothing.
      if ((err.killed || err.signal === 'SIGKILL') && !mutant('timeout_is_absent')) return resolve('ambiguous');
      resolve('failed');
    });
  });
}

const closing = (runId) => one(`SELECT COUNT(*) AS n FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL AND "closing" = 0`, runId).n === 0;
// D1 §8.3: a callback or a renewal is accepted only on an unexpired lease. Expiry is final.
const activeLease = (runId) => one(`SELECT * FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL AND "closing" = 0`, runId);
const expired = (lease) => !mutant('expired_lease_accepted') && Date.parse(lease.expires_at) <= now();
const renew = (lease) => exec('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?', iso(), iso(now() + cfg.lease_ttl * 1000), lease.id);

// E25 item 1, E27 item 2: the engine renews the lease of every run it is
// preparing (claimed, not yet spawned) and of every run whose live process it
// supervises, at least every third of the lease's lifetime. E27 item 5: once
// it has decided to end a run, it renews nothing for it.
function renewSupervised() {
  if (mutant('no_self_renewal')) return;
  for (const [id, known] of live) {
    if (known.intended) continue;
    const supervising = known.child && known.child.exitCode === null && known.child.signalCode === null;
    const preparing = !known.child && known.spawned === false && !mutant('no_renewal_while_preparing');
    if (!supervising && !preparing) continue;
    const lease = activeLease(id);
    if (!lease || expired(lease)) continue;
    if (now() - Date.parse(lease.renewed_at) >= (cfg.lease_ttl * 1000) / 3) renew(lease);
  }
}
function appendStatus(project, receipt, status) {
  insert('invocation_status_observations', {
    id: newId('iso_'),
    created_at: iso(),
    project,
    invocation: receipt,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "invocation_status_observations" WHERE "invocation" = ?', receipt).n,
    status,
    at: iso(),
  });
  emit('invocation.status', { invocation: receipt, project, run: one('SELECT "run" FROM "invocation_receipts" WHERE "id" = ?', receipt).run }, { status });
}

async function launch(id, { receipt, domain, workspace, role }) {
  const known = live.get(id);
  await barrier('launch.before_spawn');
  const r = getRun(id);
  if ((r.state !== 'claimed' || closing(id)) && !mutant('spawn_after_stop')) return; // stopped or abandoned while it waited
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
      // E27 item 5: once the end of the run is decided, nothing renews its lease.
      const lease = activeLease(id);
      if (lease && !expired(lease) && (!known.intended || heartbeatRenewsAfterDecided())) renew(lease);
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
      if (validResult(message.result)) await barrier('run.result_received');
      if (!fenced) {
        // The result is recorded in a transaction of its own. A store failure
        // there is retried, briefly: the result is the work the role was run for.
        for (const wait of [0, 100, 300]) {
          if (wait > 0) await sleep(wait);
          if (known.intended || getRun(id).state !== 'executing') break;
          try {
            tx(() => {
              exec(`UPDATE "runs" SET "state" = 'validating' WHERE "id" = ?`, id);
              emit('run.validating', runSubject(r));
            });
            break;
          } catch (err) {
            process.stderr.write(`result ${id}: ${err.message}\n`);
          }
        }
        if (getRun(id).state !== 'validating') return; // never recorded: the run ends by what was recorded
      }
      known.result = message.result;
      if (fenced && mutant('late_success_completes')) {
        // The defect: a success that arrives after the lease closed still completes the work.
        const item = one('SELECT * FROM "work_items" WHERE "id" = ?', r.work_item);
        if (item.status === 'executing') transition(r.work_item, 'complete');
      }
    }
  };
  // The text of the line being read is kept in pieces and joined once, when
  // its line ending arrives: the time is linear in the line's length.
  let pieces = [];
  let lastDataAt = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    lastDataAt = Date.now();
    if (mutant('quadratic_reader')) {
      // The defect: every chunk is put after all that was read of the line so far, and the whole is searched again.
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) chain = chain.then(() => onLine(line));
      return;
    }
    let start = 0;
    for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
      const line = pieces.join('') + chunk.slice(start, end);
      pieces = [];
      start = end + 1;
      chain = chain.then(() => onLine(line));
    }
    if (start < chunk.length) pieces.push(chunk.slice(start));
  });
  // The run-end protocol begins when the role exits. What the role wrote
  // before it went is read first; the end of the stream is not waited for,
  // because a descendant that inherited it can hold it open for ever. Nor is
  // the end of the stream the exit: a role may close its stdout and go on.
  const closed = new Promise((resolve) => child.stdout.once('close', resolve));
  const roleEnded = () =>
    chain.then(() => {
      if (getRun(id).outcome !== null) return; // already ending for another reason
      const end = earned(id, known);
      if (end[0] === 'completed' && INTEGRATING[work.kind] && !known.intended && !known.accepting) {
        known.accepting = true;
        return accept(id, known).catch((err) => {
          process.stderr.write(`accept ${id}: ${err.stack}\n`);
          known.reasonText = `The run's result could not be accepted: ${err.message}`;
          endRun(id, 'failed', 'infra_error');
        });
      }
      endRun(id, ...end);
    });
  if (mutant('stdout_eof_is_exit')) closed.then(roleEnded); // the defect: the end of the output is taken for the end of the role
  child.on('exit', async () => {
    known.exitedAt = now();
    // What is already in the pipe is still read: until the pipe closes, or
    // nothing has arrived for 150 ms, and never for longer than two seconds.
    const exitedAt = Date.now();
    const quiet = async () => {
      while (Date.now() - exitedAt < 2000 && Date.now() - Math.max(exitedAt, lastDataAt) < 150) await sleep(25);
    };
    await (mutant('waits_for_stdout_eof') ? closed : Promise.race([closed, quiet()]));
    // E27 item 1: what is left without a line ending when the engine stops
    // reading is a line like any other.
    const rest = buffer + pieces.join('');
    buffer = '';
    pieces = [];
    child.stdout.removeAllListeners('data');
    if (rest !== '' && !mutant('unterminated_line_dropped')) chain = chain.then(() => onLine(rest));
    roleEnded();
  });
}

// The unreleased run lease of the run is past its expiry.
const leaseExpired = (runId) => {
  const lease = one(`SELECT * FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL`, runId);
  return Boolean(lease) && Date.parse(lease.expires_at) <= now();
};

// The end of a run whose role has exited, or whose lease is being reconciled,
// when nothing else has decided it. E27 item 3: if the lease expired before
// the role earned anything, the run is treated as recovered, not as failed.
function earned(id, known) {
  const [outcome, reason] = outcomeOf(known);
  if (reason === 'infra_error' && leaseExpired(id) && !mutant('lease_expiry_fails_run')) return ['recovered', 'recovered'];
  // The defect `expiry_beats_clean_exit`: a lease found expired when the engine
  // comes to act on a clean exit makes the run recovered, although the result
  // was accepted and the role had exited before the expiry.
  if (mutant('expiry_beats_clean_exit') && leaseExpired(id)) return ['recovered', 'recovered'];
  return [outcome, reason];
}

// What a role that has exited earned (SEAM.md §13); a role that has not
// exited earned nothing yet.
function outcomeOf(known) {
  const exited = known?.child && (known.child.exitCode !== null || known.child.signalCode !== null);
  if (!exited || known.result === undefined) return ['failed', 'infra_error'];
  if (!validResult(known.result)) return ['failed', 'invalid_result'];
  return known.child.exitCode === 0 ? ['completed', 'none'] : ['failed', 'infra_error'];
}

const validResult = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && v.status === 'completed' && typeof v.summary === 'string' && ['checkpoint', 'nominate'].every((key) => !(key in v) || typeof v[key] === 'boolean');

// ---- the run-end protocol (D1 §4.5; SEAM.md §16) ---------------------------------------------

function endRun(id, outcome, reason, { recovery = false } = {}) {
  const known = live.get(id) ?? { spawned: null, child: null, result: undefined, ending: null };
  live.set(id, known);
  if (known.ending) return known.ending;
  // The end the engine decided, kept so that every later attempt, its own
  // retry or a reconciliation, ends the run with the same outcome.
  known.intended ??= [outcome, reason];
  known.recovery = known.recovery || recovery;
  const [decided, why] = known.intended;
  // An attempt is under way from here: nothing else starts another beside it.
  known.failed = false;
  known.ending = (async () => {
    const r = getRun(id);
    if (r.state === 'ended') return;
    tx(() => {
      if (r.outcome === null || (recovery && mutant('recovery_overwrites_outcome'))) {
        exec('UPDATE "runs" SET "outcome" = ?, "reason_class" = ?, "reason_text" = ? WHERE "id" = ?', decided, why, known.reasonText ?? null, id);
      }
      if (r.state !== 'finalizing') {
        exec(`UPDATE "runs" SET "state" = 'finalizing' WHERE "id" = ?`, id);
        emit('run.finalizing', runSubject(r));
      }
      exec(`UPDATE "leases" SET "closing" = 1 WHERE "resource_id" = ? AND "released_at" IS NULL`, id);
    });
    if (getRun(id).outcome === 'abandoned' && mutant('discard_before_termination')) discardWorkspace(getRun(id));
    const terminated = await establishTermination(id, known, known.recovery);
    if (!terminated) return void quarantine(id);
    await finishRun(id, known, known.recovery);
  })().then(
    () => {
      known.failed = false;
      known.failures = 0;
    },
    (err) => {
      // Every step above can be repeated (E28 item 1): the engine retries the
      // end itself, half a second later and then at doubling intervals, and at
      // every tick. The expiry of the lease, which nothing renews any more, is
      // the backstop.
      process.stderr.write(`endRun ${id}: ${err.stack}\n`);
      known.failed = true;
      known.ending = null;
      known.failures = (known.failures ?? 0) + 1;
      // The defect `refusal_fault_fails_run`: a refusal whose record failed is turned into a failure of the run.
      if (mutant('refusal_fault_fails_run') && known.intended?.[0] === 'refused') known.intended = ['failed', 'infra_error'];
      if (!NO_RETRY) setTimeout(() => retryEnd(id), Math.min(500 * 2 ** (known.failures - 1), 10_000)).unref();
    },
  );
  return known.ending;
}

function retryEnd(id) {
  const known = live.get(id);
  if (!known?.failed || known.ending || !known.intended) return;
  const r = getRun(id);
  if (!r || r.state === 'ended' || r.quarantined) return;
  endRun(id, ...known.intended);
}

// D1 §8.1 step 1: a run lease past its expiry is reconciled through the
// run-end protocol, whether or not this engine is still alive and supervising.
// An outcome recorded, or decided by this engine before the expiry, stands;
// otherwise the run is treated as recovered (E27 item 3).
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
    let end = r.outcome !== null ? [r.outcome, r.reason_class] : (known?.intended ?? earned(r.id, known));
    // The defect: every run whose lease expired is treated as recovered, whatever had been decided for it.
    if (mutant('expiry_forgets_decided_end') && r.outcome === null) end = ['recovered', 'recovered'];
    if (known) known.intended = null;
    await endRun(r.id, ...end);
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
      // An unknown report is acted on when it is made (SEAM.md §14). It ends
      // the wait for a report, not the signalling: what was found is still
      // killed once terminate_grace has passed (D1 §4.5 step 2).
      if (report === 'unknown' && !mutant('unknown_waits_for_grace')) {
        if (!killed && !mutant('unknown_stops_signalling')) {
          setTimeout(() => signal(d.id, 'SIGKILL'), Math.max(0, cfg.terminate_grace * 1000 - (Date.now() - started)));
        }
        break;
      }
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
  let op;
  tx(() => {
    op = journalIntend(r.project, r.id, 'worktree_remove');
  });
  // Removing what is already gone is no failure: the effect can be repeated.
  try {
    git(project.dev_repo_path, ['worktree', 'remove', '--force', ws.path]);
  } catch {
    rmSync(ws.path, { recursive: true, force: true });
    git(project.dev_repo_path, ['worktree', 'prune']);
  }
  tx(() => {
    journalSettle(r.project, r.id, 'worktree_remove', op);
    exec(`UPDATE "workspaces" SET "disposition" = 'discarded', "disposed_at" = ? WHERE "id" = ?`, iso(), ws.id);
  });
}

async function finishRun(id, known, recovery) {
  await barrier('run_end.before_ended');
  const r = getRun(id);
  if (r.outcome === 'abandoned') discardWorkspace(r);
  known.finishes = (known.finishes ?? 0) + 1;
  // A recovery, once termination is established, captures the snapshot of
  // what the role left, and accepts nothing (SEAM.md §28).
  const left = one('SELECT * FROM "workspaces" WHERE "run" = ?', id);
  if (recovery && left && left.snapshot_tree === null && existsSync(left.path) && !mutant('recovery_no_snapshot')) {
    try {
      const tree = G.snapshot(left.path, G.gitDirOf(left.path), left.current_base);
      exec('UPDATE "workspaces" SET "snapshot_tree" = ? WHERE "id" = ?', tree, left.id);
      if (mutant('recovery_commits')) {
        // The defect: a recovery takes what it found for accepted work.
        const p = projectRow(r.project);
        const sha = commitTree(p, { run: id, tree, parent: left.current_base, message: 'recovered\n' });
        tx(() => recordRevision(p, { sha, parent: left.current_base, kind: 'engine_commit', run: id }));
      }
    } catch (err) {
      process.stderr.write(`recovery snapshot ${id}: ${err.message}\n`);
    }
  }
  // What a workspace that stays holds when its run ends is its baseline as a managed checkout.
  let endBaseline = null;
  if (left && r.outcome !== 'abandoned' && existsSync(left.path)) {
    try {
      endBaseline = JSON.stringify(G.checkoutBaseline(left.path));
    } catch {
      // a workspace whose git link the role destroyed has no baseline to take
    }
  }
  // What this incarnation knows of the spawn is kept for as long as it lives,
  // so a repeated attempt records what the first would have. The defect
  // `retry_forgets_never_launched`: a repeated attempt no longer knows.
  const spawned = mutant('retry_forgets_never_launched') && known.finishes > 1 ? null : known.spawned;
  const terminalOf = (receipt) => {
    const statuses = all('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ?', receipt.id).map((s) => s.status);
    if (statuses.some((s) => ['ended', 'unknown', 'refused'].includes(s))) return null;
    const started = statuses.includes('dispatch_started');
    const launchedForSure = statuses.includes('launched') || spawned === true || known.memberSeen === true;
    // Never launched: this incarnation dispatched it and did not spawn, or
    // the dispatch had not started. Otherwise, launched, or not known.
    const neverLaunched = !launchedForSure && (!started || spawned === false);
    return { neverLaunched, status: neverLaunched ? 'refused' : launchedForSure ? 'ended' : 'unknown' };
  };
  if (mutant('status_outside_tx')) {
    // The defect: the terminal observation is written on its own, before the
    // transaction that charges and ends the run, so a failure of that
    // transaction leaves the observation behind and a repeated attempt skips
    // the receipt it finds already observed.
    for (const receipt of all('SELECT * FROM "invocation_receipts" WHERE "run" = ?', id)) {
      const terminal = terminalOf(receipt);
      if (terminal) {
        try {
          appendStatus(r.project, receipt.id, terminal.status);
        } catch {
          // the fault was on this event; the next attempt writes it
        }
        known.observedAlone = true;
      }
    }
  }
  tx(() => {
    // Finishing a run that has ended writes nothing (D1 §4.5: endRun is idempotent).
    if (getRun(id).state === 'ended') return;
    for (const receipt of all('SELECT * FROM "invocation_receipts" WHERE "run" = ?', id)) {
      const terminal = terminalOf(receipt);
      if (terminal === null && !(known.observedAlone && known.finishes === 1)) continue;
      const neverLaunched = terminal ? terminal.neverLaunched : !all('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ?', receipt.id).some((s) => ['ended', 'unknown'].includes(s.status));
      if (terminal) appendStatus(r.project, receipt.id, terminal.status);
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
      emit('ledger.row', { run: id, project: r.project, invocation: receipt.id });
    }
    exec(`UPDATE "workspaces" SET "disposition" = 'retained' WHERE "run" = ? AND "disposition" IN ('active', 'quarantined')`, id);
    if (endBaseline) exec('UPDATE "managed_checkouts" SET "baseline" = ? WHERE "owner_run" = ?', endBaseline, id);
    else exec('DELETE FROM "managed_checkouts" WHERE "owner_run" = ?', id);
    if (!mutant('grant_not_revoked')) exec('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL', iso(), id);
    if (mutant('clearance_revives_grant') && r.quarantined) exec('UPDATE "capability_grants" SET "revoked_at" = NULL WHERE "run" = ?', id);
    if (!mutant('lease_not_released')) exec('UPDATE "leases" SET "released_at" = ? WHERE "resource_id" = ? AND "released_at" IS NULL', iso(), id);
    exec(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = 'termination observed' WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`, id);
    // A confirmation that was never consumed asks about a run that is over.
    exec(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = 'the run has ended' WHERE "kind" IN ('stop_confirm', 'abandon_confirm') AND "subject_id" = ? AND "status" = 'open'`, id);
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
    case 'failed': {
      // The progress key is taken over the snapshot tree of an attempt that
      // failed validation (D1 §4.3): the same tree again is no progress.
      const attempt = one('SELECT "snapshot_tree" FROM "workspaces" WHERE "run" = ?', r.id);
      if (attempt?.snapshot_tree && !mutant('no_progress_ignored')) {
        // Two defects: a key that also holds the run, so that it never repeats; a key that holds nothing, so that it always does.
        const key = sha256(mutant('progress_key_includes_run') ? `${attempt.snapshot_tree}:${r.id}` : mutant('progress_key_constant') ? 'the same' : attempt.snapshot_tree);
        if (key === item.progress_key) {
          exec('UPDATE "work_items" SET "no_progress_count" = "no_progress_count" + 1 WHERE "id" = ?', item.id);
          if (item.no_progress_count + 1 >= policyOf(item.project).no_progress_max) {
            park(item.id, 'no_progress_max');
            break;
          }
        } else exec('UPDATE "work_items" SET "progress_key" = ? WHERE "id" = ?', key, item.id);
      }
      if (item.repair_attempts >= policyOf(item.project).repair_attempts_max && !mutant('repair_unbounded')) park(item.id, 'repair_attempts_max');
      else {
        transition(item.id, 'eligible');
        exec('UPDATE "work_items" SET "pending_repair" = 1 WHERE "id" = ?', item.id);
      }
      break;
    }
    case 'refused':
      exec('UPDATE "work_items" SET "preflight_refusals" = "preflight_refusals" + 1 WHERE "id" = ?', item.id);
      if (item.preflight_refusals + 1 >= policyOf(item.project).preflight_refusals_max && !mutant('preflight_unbounded')) park(item.id, 'preflight_refusals_max');
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
    if (mutant('quarantine_then_snapshot') && known.unsnapshotted) {
      // The defect: a quarantine that clears is snapshotted after the fact.
      const ws = one('SELECT * FROM "workspaces" WHERE "run" = ?', r.id);
      exec('UPDATE "workspaces" SET "snapshot_tree" = ? WHERE "id" = ?', G.snapshot(ws.path, G.gitDirOf(ws.path), ws.current_base), ws.id);
    }
    await finishRun(r.id, known, false);
  }
}

// ---- slice 3: registry, journal, snapshot, validation, commit, integration, integrity ----
// (SEAM.md §§27–34). Synchronous git around rows; nothing here could recover
// what it journals. It exists so the slice-3 tests can be shown satisfiable.

const INTEGRATING = { stage_build: 'builder', fix: 'builder', replan: 'architect', assessment: 'architect' };
const projectRow = (id) => one('SELECT * FROM "projects" WHERE "id" = ?', id);
const integrationRef = (p) => `refs/heads/${p.integration_branch}`;
const registered = (project, ref) => one('SELECT * FROM "ref_registry" WHERE "project" = ? AND "ref" = ?', project, ref);
const nextRefNumber = (project, kind) => one('SELECT COUNT(*) + 1 AS n FROM "ref_registry" WHERE "project" = ? AND "kind" = ?', project, kind).n;
function registerRef(project, ref, kind, oid, immutable = 0) {
  const row = registered(project, ref);
  if (row) exec('UPDATE "ref_registry" SET "expected_oid" = ? WHERE "id" = ?', oid, row.id);
  else insert('ref_registry', { id: newId('ref_'), created_at: iso(), project, ref, kind, expected_oid: oid, immutable });
}

// A journaled operation of the kinds slice 3 adds: its row and `intended`
// event in one transaction, later events one at a time.
function journalOpen(project, kind, journalKind, payload) {
  const op = newId('op_');
  insert('operations', {
    id: op,
    created_at: iso(),
    project,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "operations" WHERE "project" = ?', project).n,
    kind,
    target: JSON.stringify({ repo: payload.repo, ref: payload.ref ?? null }),
    subject: '{}',
    idempotency_key: sha256(`${journalKind}:${JSON.stringify(payload)}:${op}`),
    semantic_generation: 1,
    status: 'intended',
    deadline_at: iso(now() + cfg.git_deadline * 1000),
  });
  emit('operation.intended', { operation: op, project, run: payload.run ?? null });
  insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: op, seq: 1, journal_kind: journalKind, event_kind: 'intended', payload: JSON.stringify(payload) });
  emit('git.journal_intended', { operation: op, project, run: payload.run ?? null });
  return op;
}
function journalAppend(project, op, journalKind, eventKinds, payload, status) {
  const from = one('SELECT COALESCE(MAX("seq"), 0) AS n FROM "git_journal_events" WHERE "operation" = ?', op).n;
  eventKinds.forEach((eventKind, i) => {
    insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: op, seq: from + i + 1, journal_kind: journalKind, event_kind: eventKind, payload: JSON.stringify(payload) });
    if (eventKind !== 'failed') emit(`git.journal_${eventKind}`, { operation: op, project, run: payload.run ?? null });
  });
  exec('UPDATE "operations" SET "status" = ?, "finalized_at" = ? WHERE "id" = ?', status, status === 'succeeded' ? iso() : null, op);
  emit(`operation.${status}`, { operation: op, project, run: payload.run ?? null });
  if (status === 'succeeded') emit('operation.finalized', { operation: op, project, run: payload.run ?? null });
}

// A tree made of another tree plus some files, without touching any checkout.
function treeWith(repo, base, files) {
  const index = join(G.repoDir(repo), `witness-index-${process.hrtime.bigint()}`);
  const extraEnv = { GIT_INDEX_FILE: index };
  try {
    git(repo, ['read-tree', base], { extraEnv });
    for (const [path, content] of Object.entries(files)) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: content });
      git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { extraEnv });
    }
    return git(repo, ['write-tree'], { extraEnv });
  } finally {
    rmSync(index, { force: true });
  }
}

// commit-tree with a frozen parent and tree, published under a keep ref (D1 §§6.5, 7.3, 7.10).
function commitTree(p, { run = null, tree, parent, message }) {
  const repo = p.dev_repo_path;
  const payload = { repo, tree, old_oid: parent, run };
  let op;
  tx(() => {
    op = journalOpen(p.id, 'git_commit', 'commit_tree', payload);
  });
  const sha = git(repo, ['commit-tree', tree, '-p', parent], { input: message });
  const keep = `refs/surety/keep/${nextRefNumber(p.id, 'keep')}`;
  git(repo, ['update-ref', keep, sha]);
  tx(() => {
    registerRef(p.id, keep, 'keep', sha, 1);
    journalAppend(p.id, op, 'commit_tree', ['applied', 'confirmed', 'finalized'], { ...payload, new_oid: sha }, 'succeeded');
  });
  return sha;
}

class IntegrationRefused extends Error {
  constructor(worktree) {
    super(`the integration branch is checked out in ${worktree}`);
    this.worktree = worktree;
  }
}
const FREE_THE_BRANCH = 'Switch that worktree to another branch, or detach it (git checkout --detach), then retry.';

// A ref moved by compare-and-swap through the journal (D1 §7.5). With
// `recheck`, the branch must not be checked out in a worktree the engine does
// not own, looked at again immediately before the ref would move.
async function refUpdate(p, { run = null, ref, oldOid, newOid, recheck = false }) {
  const repo = p.dev_repo_path;
  const payload = { repo, ref, old_oid: oldOid, new_oid: newOid, run };
  let op;
  tx(() => {
    op = journalOpen(p.id, 'git_ref_update', 'ref_update', payload);
  });
  if (mutant('shell_interpolates')) {
    // The defect: a ref's name is put into a shell command.
    try {
      execFileSync('sh', ['-c', `echo ${ref} > /dev/null`], { cwd: home, stdio: 'ignore' });
    } catch {
      // whatever it did, it did
    }
  }
  await barrier('journal.ref_update.intent_committed');
  if (recheck && !mutant('no_recheck_before_cas') && !mutant('integrates_checked_out_branch')) {
    const [held] = G.checkoutsOf(repo, ref);
    if (held) {
      tx(() => journalAppend(p.id, op, 'ref_update', ['failed'], payload, 'failed'));
      throw new IntegrationRefused(held.path);
    }
  }
  git(repo, ['update-ref', ref, newOid, oldOid ?? '0'.repeat(40)]);
  tx(() => {
    // The finalizer: the registry now expects what the engine put there.
    // The defect `own_ref_ops_observed`: it is not told.
    if (registered(p.id, ref) && !mutant('own_ref_ops_observed')) registerRef(p.id, ref, null, newOid);
    journalAppend(p.id, op, 'ref_update', ['applied', 'confirmed', 'finalized'], { ...payload, confirmed_oid: newOid }, 'succeeded');
  });
}

function commitMessage(r, item, base, result) {
  const trailers = [`Surety-Run: ${r.id}`, `Surety-Role: ${r.role}`, `Surety-Base: ${base}`, `Surety-WorkItem: ${item.id}`, `Surety-Kind: ${item.kind}`].join('\n');
  // The defect `summary_in_trailers`: the role's summary is put where the trailers are.
  if (mutant('summary_in_trailers')) return `${item.kind} run\n\n${result.summary}\n${trailers}\n`;
  return `${item.kind} run ${r.seq}\n\n${trailers}\n`;
}

// What a snapshot may not hold, and what must be as the engine left it
// (SEAM.md §28; contract/snapshot-validation.json). Returns {reason, text} or null.
function violation(p, r, ws, tree, known) {
  const repo = p.dev_repo_path;
  const base = ws.current_base;
  const outside = (text) => ({ reason: 'ref_violation', text });
  const inside = (text) => ({ reason: 'diff_violation', text });
  const meta = known.meta;
  if (meta) {
    if (!mutant('no_check_gitlink') && readFileSync(join(ws.path, '.git'), 'utf8') !== meta.gitFile) return outside("the workspace's .git file was changed");
    if (!mutant('no_check_head')) {
      let head = null;
      let branch = null;
      try {
        head = G.run(meta.gitDir, ['rev-parse', 'HEAD']);
      } catch {
        // no HEAD to read
      }
      try {
        branch = G.run(meta.gitDir, ['symbolic-ref', '-q', 'HEAD']);
      } catch {
        // detached, as it should be
      }
      if (head !== base || branch) return outside(`the workspace's HEAD is ${branch ?? head}, not detached at its base ${base}`);
    }
    if (!mutant('no_check_index') && sha256(G.run(meta.gitDir, ['ls-files', '-s', '-z'], { workTree: ws.path })) !== meta.index) return outside("the workspace's index was changed");
    const hooksDir = join(G.repoDir(repo), 'hooks');
    const hooks = existsSync(hooksDir) ? sha256(readdirSync(hooksDir).sort().map((name) => `${name} ${sha256(readFileSync(join(hooksDir, name)))}`).join('\n')) : sha256('');
    if (!mutant('no_check_config') && sha256(readFileSync(join(G.repoDir(repo), 'config'))) !== meta.config) return outside("the repository's configuration was changed");
    if (!mutant('no_check_hooks') && hooks !== meta.hooks) return outside("the repository's hooks directory was changed");
  }
  if (!mutant('no_check_refs')) {
    for (const row of all('SELECT * FROM "ref_registry" WHERE "project" = ?', p.id)) {
      const found = G.refOid(repo, row.ref);
      if (found !== row.expected_oid) return outside(`the registered ref ${row.ref} is at ${found ?? 'nothing'}, not at ${row.expected_oid}`);
    }
  }
  if (!mutant('no_check_other_checkouts')) {
    for (const c of all('SELECT * FROM "managed_checkouts" WHERE "project" = ? AND ("owner_run" IS NULL OR "owner_run" <> ?)', p.id, r.id)) {
      if (!existsSync(c.path)) continue;
      let current;
      try {
        current = JSON.stringify(G.checkoutBaseline(c.path));
      } catch {
        continue;
      }
      if (current !== c.baseline) return outside(`the managed checkout ${c.path} was altered`);
    }
  }

  const changed = G.changes(repo, base, tree);
  // The defect of D1 §7.3 step 4 as drafted: the run's own edits count as an altered checkout.
  if (mutant('own_edit_is_ref_violation') && changed.length > 0) return outside("the run's own workspace was altered");
  if (mutant('external_diff_runs')) {
    try {
      execFileSync('git', ['--git-dir', G.repoDir(repo), 'diff', base, tree], { env: { PATH: process.env.PATH, HOME: home }, stdio: 'ignore', timeout: 10_000 });
    } catch {
      // the defect is that it was run at all
    }
  }
  const policy = policyOf(p.id);
  const sized = [];
  for (const c of changed) {
    if (mutant('shell_interpolates')) {
      // The defect: a name a role chose is put into a shell command.
      try {
        execFileSync('sh', ['-c', `echo ${c.path} > /dev/null`], { cwd: ws.path, stdio: 'ignore' });
      } catch {
        // whatever it did, it did
      }
    }
    if (!mutant('no_role_paths')) {
      const refused = pathViolation(r.role, c.path);
      if (refused) return inside(refused);
    }
    if (c.status === 'D') continue;
    if (c.mode === '120000') {
      if (!mutant('no_link_check') && G.linkEscapes(ws.path, c.path, git(repo, ['cat-file', 'blob', c.oid]))) return inside(`the symbolic link ${c.path} leads outside the workspace`);
      continue;
    }
    if (c.mode !== '100644' && c.mode !== '100755') {
      if (!mutant('no_kind_check')) return inside(`${c.path} is neither a regular file nor a symbolic link (mode ${c.mode})`);
      continue;
    }
    sized.push(c);
  }
  if (!mutant('no_caps')) {
    if (sized.length > policy.snapshot_max_files) return inside(`${sized.length} files, more than snapshot_max_files (${policy.snapshot_max_files})`);
    const sizes = sized.length === 0 ? [] : git(repo, ['cat-file', '--batch-check=%(objectsize)'], { input: `${sized.map((c) => c.oid).join('\n')}\n` }).split('\n').map(Number);
    let total = 0;
    for (const [i, c] of sized.entries()) {
      if (sizes[i] > policy.snapshot_max_file_bytes) return inside(`${c.path} has ${sizes[i]} bytes, more than snapshot_max_file_bytes (${policy.snapshot_max_file_bytes})`);
      total += sizes[i];
    }
    if (total > policy.snapshot_max_bytes) return inside(`${total} bytes, more than snapshot_max_bytes (${policy.snapshot_max_bytes})`);
  }
  return null;
}

function recordRevision(p, { sha, parent, kind, run }) {
  const id = newId('rev_');
  insert('revisions', { id, created_at: iso(), project: p.id, sha, parent_sha: parent, kind, created_by_run: run, recorded_at: iso() });
  emit('revision.recorded', { project: p.id, revision: id }, { sha, kind });
  return id;
}

// What follows a valid result of a Builder's or an Architect's run whose
// role exited 0 (SEAM.md §28): termination, snapshot, validation, commit,
// and then a checkpoint or the integration.
async function accept(id, known) {
  const r = getRun(id);
  const p = projectRow(r.project);
  const item = one('SELECT * FROM "work_items" WHERE "id" = ?', r.work_item);
  const ws = one('SELECT * FROM "workspaces" WHERE "run" = ?', id);
  const gitDirOfWs = known.meta?.gitDir ?? G.gitDirOf(ws.path);
  // The defect `snapshot_before_termination`: captured while a writer may live.
  if (mutant('snapshot_before_termination')) exec('UPDATE "workspaces" SET "snapshot_tree" = ? WHERE "id" = ?', G.snapshot(ws.path, gitDirOfWs, ws.current_base), ws.id);

  // 1. No snapshot before the domain has been shown empty.
  if (!(await establishTermination(id, known, false))) {
    known.reasonText = "The run's domain could not be shown empty, so what the role left could not be established.";
    known.unsnapshotted = true;
    // The defect `quarantined_completed`: the outcome recorded with the quarantine claims a validation that never happened.
    return void endRun(id, ...(mutant('quarantined_completed') ? ['completed', 'none'] : ['failed', 'infra_error']));
  }
  if (mutant('absorbs_outside_files')) {
    // The defect: what the role left beside its workspace is taken into it.
    for (const name of readdirSync(join(ws.path, '..'))) {
      const stray = join(ws.path, '..', name);
      if (statSync(stray).isFile()) writeFileSync(join(ws.path, name), readFileSync(stray));
    }
  }
  // 2. The snapshot.
  const tree = G.snapshot(ws.path, gitDirOfWs, ws.current_base);
  exec('UPDATE "workspaces" SET "snapshot_tree" = ? WHERE "id" = ?', tree, ws.id);
  // 3. Validation: a violation rejects the whole result.
  const bad = violation(p, r, ws, tree, known);
  if (bad) {
    known.reasonText = bad.text;
    return void endRun(id, 'failed', bad.reason);
  }
  // 4. The commit.
  const checkpoint = known.result.checkpoint === true;
  const kind = checkpoint ? 'checkpoint' : r.role === 'architect' && !mutant('architect_engine_commit') ? 'intent' : 'engine_commit';
  const sha = commitTree(p, { run: id, tree, parent: ws.current_base, message: commitMessage(r, item, ws.current_base, known.result) });
  let revision;
  tx(() => {
    revision = recordRevision(p, { sha, parent: ws.current_base, kind, run: id });
  });
  const ref = integrationRef(p);
  // 5a. A checkpoint is a working revision: nothing is integrated.
  if (checkpoint && !mutant('checkpoint_integrates')) {
    tx(() => {
      exec('UPDATE "workspaces" SET "current_base" = ?, "checkpoints" = ? WHERE "id" = ?', sha, JSON.stringify([...json(ws.checkpoints ?? '[]'), revision]), ws.id);
      if (mutant('checkpoint_rewrites_base')) {
        exec('UPDATE "workspaces" SET "base_revision" = ? WHERE "id" = ?', sha, ws.id);
        exec('UPDATE "runs" SET "base_revision" = ? WHERE "id" = ?', sha, id);
      }
      transition(item.id, 'eligible');
      exec('UPDATE "work_items" SET "checkpoint_run" = ? WHERE "id" = ?', id, item.id);
    });
    return void endRun(id, 'completed', 'none');
  }
  // 5b. The integration, refused while the branch is checked out in a worktree the engine does not own.
  try {
    tx(() => transition(item.id, 'integrating'));
    if (!mutant('integrates_checked_out_branch')) {
      const [held] = G.checkoutsOf(p.dev_repo_path, ref);
      if (held) throw new IntegrationRefused(held.path);
    }
    await refUpdate(p, { run: id, ref, oldOid: registered(p.id, ref).expected_oid, newOid: sha, recheck: true });
    if (mutant('integration_touches_checkouts')) {
      // The defect: a checkout-updating protocol nobody asked for.
      for (const w of G.worktrees(p.dev_repo_path)) {
        if (G.engineOwned(w.path)) continue;
        try {
          G.run(G.gitDirOf(w.path), ['checkout', '-q', '--detach', sha], { workTree: w.path });
        } catch {
          // it tried
        }
      }
    }
    if (!mutant('no_integrated_transition')) tx(() => transition(item.id, 'integrated'));
  } catch (err) {
    if (!(err instanceof IntegrationRefused)) throw err;
    known.reasonText = `The integration branch ${p.integration_branch} is checked out in ${err.worktree}, a worktree the engine does not own; the branch was not moved. ${FREE_THE_BRANCH}`;
    tx(() => park(item.id, 'integration_branch_checked_out', `The integration branch ${p.integration_branch} is checked out in ${err.worktree}. ${FREE_THE_BRANCH}`));
    return void endRun(id, 'failed', 'integration_conflict');
  }
  endRun(id, 'completed', 'none');
}

// ---- repository integrity (D1 §7.6; SEAM.md §32) ----

function raiseOob(p, subjectKind, { ref = null, checkout = null, expected, found, options, question }) {
  const id = newId('oob_');
  const decision = raiseDecision(p.id, 'out_of_band_change', 'out_of_band_change', id, options, question);
  insert('out_of_band_changes', { id, created_at: iso(), project: p.id, subject_kind: subjectKind, ref, checkout, expected, found, detected_at: iso(), decision });
  emit('repo.out_of_band', { project: p.id, out_of_band_change: id }, { subject_kind: subjectKind });
}
const unreconciled = (projectId) =>
  all(
    `SELECT o.* FROM "out_of_band_changes" o JOIN "decisions" d ON d."id" = o."decision"
     WHERE o."project" = ? AND o."disposition" IS NULL AND d."status" = 'open'`,
    projectId,
  );
// Nothing of a project is dispatched or integrated while its integration
// branch or its repository has an unreconciled observation.
function projectBlocked(p) {
  const branch = registered(p.id, integrationRef(p));
  return unreconciled(p.id).some((o) => o.subject_kind === 'repository' || (o.subject_kind === 'ref' && o.ref === branch?.id));
}

function registerCheckouts(p) {
  const known = all(`SELECT * FROM "managed_checkouts" WHERE "project" = ? AND "kind" = 'integration_worktree'`, p.id);
  for (const w of G.checkoutsOf(p.dev_repo_path, integrationRef(p))) {
    if (known.some((row) => G.real(row.path) === G.real(w.path))) continue;
    insert('managed_checkouts', { id: newId('mc_'), created_at: iso(), project: p.id, kind: 'integration_worktree', path: w.path, baseline: JSON.stringify(G.checkoutBaseline(w.path)), owner_run: null });
  }
}

function integrity(p) {
  const repo = p.dev_repo_path;
  const openRepository = unreconciled(p.id).find((o) => o.subject_kind === 'repository');
  if (!G.readable(repo)) {
    // The defect `unreadable_is_clean`: what cannot be read is taken for unchanged.
    if (mutant('unreadable_is_clean')) return;
    if (!openRepository) {
      tx(() => raiseOob(p, 'repository', { expected: repo, found: null, options: mutant('unreadable_offers_reset') ? ['discard'] : [], question: `The repository ${repo} cannot be read.` }));
    }
    return;
  }
  if (openRepository) {
    tx(() => {
      exec(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = 'the repository can be read again' WHERE "id" = ?`, openRepository.decision);
      emit('decision.invalidated', { decision: openRepository.decision, project: p.id });
      emit('repo.reconciled', { project: p.id, out_of_band_change: openRepository.id });
    });
    // The defect `no_fresh_integrity`: the refs are not read again before the project goes on.
    if (mutant('no_fresh_integrity')) return;
  }
  if (mutant('feature_branch_observed')) {
    // The defect: every branch is taken into the registry.
    for (const line of git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']).split('\n').filter(Boolean)) {
      const [ref, oid] = line.split(' ');
      if (!registered(p.id, ref)) registerRef(p.id, ref, 'lineage', oid);
    }
  }
  for (const row of all('SELECT * FROM "ref_registry" WHERE "project" = ?', p.id)) {
    const found = G.refOid(repo, row.ref);
    if (found === row.expected_oid) continue;
    if (mutant('deleted_ref_as_expected') && found === null) continue;
    // The defect `oob_absorbed`: the expected value silently becomes what was found.
    if (mutant('oob_absorbed') && found !== null) {
      exec('UPDATE "ref_registry" SET "expected_oid" = ? WHERE "id" = ?', found, row.id);
      continue;
    }
    const already = one(`SELECT 1 FROM "out_of_band_changes" WHERE "project" = ? AND "subject_kind" = 'ref' AND "ref" = ? AND "disposition" IS NULL`, p.id, row.id);
    if (already && !mutant('oob_repeated')) continue;
    tx(() => raiseOob(p, 'ref', { ref: row.id, expected: row.expected_oid, found, options: found === null ? ['discard'] : ['discard', 'adopt'], question: `The registered ref ${row.ref} is at ${found ?? 'nothing'}; the engine expects it at ${row.expected_oid}.` }));
  }
  const current = G.checkoutsOf(repo, integrationRef(p));
  for (const row of all(`SELECT * FROM "managed_checkouts" WHERE "project" = ? AND "kind" = 'integration_worktree'`, p.id)) {
    // A checkout that was switched away or detached is no longer a managed checkout, and no observation.
    if (!current.some((w) => G.real(w.path) === G.real(row.path))) {
      exec('DELETE FROM "managed_checkouts" WHERE "id" = ?', row.id);
      continue;
    }
    const found = JSON.stringify(G.checkoutBaseline(row.path));
    if (found === row.baseline) continue;
    if (one(`SELECT 1 FROM "out_of_band_changes" WHERE "project" = ? AND "subject_kind" = 'checkout' AND "checkout" = ? AND "disposition" IS NULL`, p.id, row.id)) continue;
    if (mutant('checkout_reset')) {
      // The defect: the engine puts the checkout back by itself.
      G.run(G.gitDirOf(row.path), ['checkout', '-q', 'HEAD', '--', '.'], { workTree: row.path });
      continue;
    }
    tx(() => raiseOob(p, 'checkout', { checkout: row.id, expected: row.baseline, found, options: mutant('checkout_offers_discard') ? ['discard', 'adopt'] : ['stash', 'adopt'], question: `The checkout ${row.path} differs from its baseline.` }));
  }
  registerCheckouts(p);
}

// The two answers to a moved or deleted ref (D1 §7.6; D1-11).
async function answerOob(projectId, d, body) {
  const p = projectRow(projectId);
  const o = one('SELECT * FROM "out_of_band_changes" WHERE "decision" = ?', d.id);
  if (o.subject_kind !== 'ref') throw refusal(409, 'illegal_transition', 'the answers to this observation are not built before slice 5');
  const row = one('SELECT * FROM "ref_registry" WHERE "id" = ?', o.ref);
  tx(() => {
    exec(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ?, "answer" = ? WHERE "id" = ?`, iso(), JSON.stringify({ option: body.option }), d.id);
    emit('decision.answered', { decision: d.id, project: projectId });
    emit('decision.consumed', { decision: d.id, project: projectId });
  });
  if (body.option === 'discard') {
    if (o.found !== null && !mutant('discard_drops_stray')) {
      const kept = `refs/surety/oob/${nextRefNumber(projectId, 'oob')}`;
      git(p.dev_repo_path, ['update-ref', kept, o.found]);
      tx(() => registerRef(projectId, kept, 'oob', o.found));
    }
    await refUpdate(p, { ref: row.ref, oldOid: o.found, newOid: row.expected_oid });
  } else {
    tx(() => {
      exec('UPDATE "ref_registry" SET "expected_oid" = ? WHERE "id" = ?', o.found, row.id);
      if (!mutant('adopt_not_recorded')) recordRevision(p, { sha: o.found, parent: null, kind: 'out_of_band', run: null });
    });
  }
  tx(() => {
    exec('UPDATE "out_of_band_changes" SET "disposition" = ? WHERE "id" = ?', body.option, o.id);
    emit('repo.reconciled', { project: projectId, out_of_band_change: o.id });
  });
  return { status: 200, body: { decision: { id: d.id, status: 'consumed' } } };
}

// ---- projects through the API, and their policy (D1 §§3.1, 11.4; SEAM.md §27) ----

async function createProject(given, actor) {
  // The defect `bootstrap_accepts_anything`: keys the schema does not know and a tier it does not have are let through.
  const lenient = mutant('bootstrap_accepts_anything');
  const body = lenient ? { name: given.name, tier: given.tier, dev_repo_path: given.dev_repo_path, integration_branch: given.integration_branch } : given;
  for (const key of Object.keys(body)) if (!['name', 'tier', 'dev_repo_path', 'integration_branch'].includes(key)) throw refusal(400, 'unknown_field', `unknown field ${key}`, { field: key });
  if (!['T1', 'T2', 'T3'].includes(body.tier) && !lenient) throw refusal(400, 'invalid_value', 'tier is one of T1, T2, T3', { field: 'tier' });
  const repo = body.dev_repo_path;
  if (typeof repo !== 'string' || !existsSync(join(repo, '.git')) || !G.readable(repo)) throw refusal(409, 'repo_unreadable', 'dev_repo_path is not a git repository the engine can read', { path: repo });
  const ref = `refs/heads/${body.integration_branch}`;
  const head = typeof body.integration_branch === 'string' && !body.integration_branch.startsWith('-') ? G.refOid(repo, ref) : null;
  if (head === null) throw refusal(400, 'invalid_value', 'integration_branch is not a branch of that repository', { field: 'integration_branch' });
  if (!mutant('bootstrap_ignores_checkout')) {
    const [held] = G.checkoutsOf(repo, ref);
    if (held) throw refusal(409, 'integration_conflict', `The integration branch is checked out in ${held.path}; a project cannot be bootstrapped onto it.`, { worktree: held.path }, FREE_THE_BRANCH);
  }
  const id = newId('proj_');
  tx(() => {
    insert('projects', { id, created_at: iso(), name: body.name, paused: 0, tier: body.tier, dev_repo_path: repo, integration_branch: body.integration_branch, registration_state: 'pending_bootstrap', policy: '{}' });
    emit('project.created', { project: id }, { name: body.name, tier: body.tier }, actor);
    registerRef(id, ref, 'integration', head);
  });
  const p = projectRow(id);
  const files = { '.surety/project.json': `${JSON.stringify({ id, name: body.name }, null, 2)}\n` };
  if (mutant('bootstrap_extra_paths')) files['.surety/policy.json'] = '{}\n';
  const sha = commitTree(p, { tree: treeWith(repo, head, files), parent: head, message: `Register project ${id}\n` });
  await refUpdate(p, { ref, oldOid: head, newOid: sha });
  tx(() => {
    exec(`UPDATE "projects" SET "registration_state" = 'registered' WHERE "id" = ?`, id);
    emit('project.registered', { project: id });
  });
  return { status: 201, body: { project: { id, registration_state: 'registered' } } };
}

function getPolicy(projectId) {
  const p = projectRow(projectId);
  const effective = policyOf(projectId);
  if (mutant('unrecorded_policy_effective')) {
    // The defect: whatever the repository's policy file says is taken as effective.
    try {
      Object.assign(effective, JSON.parse(git(p.dev_repo_path, ['cat-file', 'blob', `${integrationRef(p)}:.surety/policy.json`])));
    } catch {
      // no such file
    }
  }
  return { status: 200, body: { effective, revision: p.policy_revision ? one('SELECT "revision" FROM "policy_revisions" WHERE "id" = ?', p.policy_revision).revision : null } };
}

async function changePolicy(projectId, body, actor) {
  for (const [key, value] of Object.entries(body)) {
    const spec = CONTRACT.project[key];
    if (!spec || key.startsWith('$')) throw refusal(400, 'unknown_field', `unknown policy key ${key}`, { field: key });
    const ok = typeof value === 'number' && (spec.integer === false || Number.isInteger(value)) && value >= spec.min && value <= spec.max;
    if (!ok) throw refusal(400, 'invalid_value', `${key} is out of range`, { field: key });
  }
  const p = projectRow(projectId);
  const repo = p.dev_repo_path;
  if (!G.readable(repo)) throw refusal(409, 'repo_unreadable', `The repository ${repo} cannot be read.`, { project: projectId });
  if (projectBlocked(p)) throw refusal(409, 'out_of_band_change', 'The project has an unreconciled out-of-band change.', { project: projectId });
  const ref = integrationRef(p);
  const [held] = G.checkoutsOf(repo, ref);
  if (held) throw refusal(409, 'integration_conflict', `The integration branch is checked out in ${held.path}.`, { worktree: held.path }, FREE_THE_BRANCH);
  const head = G.refOid(repo, ref);
  let recorded = { ...json(p.policy ?? '{}'), ...body };
  if (mutant('policy_file_merged')) {
    // The defect: an unrecorded file's content is carried into the recorded policy.
    try {
      recorded = { ...JSON.parse(git(repo, ['cat-file', 'blob', `${head}:.surety/policy.json`])), ...recorded };
    } catch {
      // no such file
    }
  }
  const sha = commitTree(p, { tree: treeWith(repo, head, { '.surety/policy.json': `${JSON.stringify(recorded, null, 2)}\n` }), parent: head, message: 'Policy change\n' });
  // The defect `policy_not_committed`: the revision is recorded and the branch never gets the file.
  if (!mutant('policy_not_committed')) await refUpdate(p, { ref, oldOid: head, newOid: sha });
  let revision;
  tx(() => {
    revision = one('SELECT COUNT(*) + 1 AS n FROM "policy_revisions" WHERE "project" = ?', projectId).n;
    const id = newId('pol_');
    insert('policy_revisions', {
      id,
      created_at: iso(),
      project: projectId,
      revision,
      git_path: '.surety/policy.json',
      git_blob: git(repo, ['rev-parse', `${sha}:.surety/policy.json`]),
      changed_by: actor.kind ?? 'human',
      changed_at: iso(),
      diff_summary: Object.keys(body).join(', '),
      widens_authority: 0,
      committed: 1,
    });
    // The defect `policy_not_used`: the revision is recorded and the settings stay what they were.
    exec('UPDATE "projects" SET "policy" = ?, "policy_revision" = ? WHERE "id" = ?', mutant('policy_not_used') ? (p.policy ?? '{}') : JSON.stringify(recorded), id, projectId);
    emit('policy.changed', { project: projectId }, { revision }, actor);
  });
  return { status: 200, body: { effective: policyOf(projectId), revision } };
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
    if (!NO_RETRY) for (const id of [...live.keys()]) retryEnd(id);
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
      for (const step of ['recover', 'journal', 'integrity']) {
        const delay = takeFault(step, p.id);
        if (delay > 0) {
          const budget = cfg.tick_step_budget * 1000;
          const dispatchesAnyway = mutant('late_step_dispatches') || (step === 'integrity' && mutant('integrity_overrun_dispatches'));
          if (delay > budget && !dispatchesAnyway) {
            suppressed.add(p.id);
            await sleep(budget);
          } else await sleep(Math.min(delay, budget));
        }
        if (step !== 'integrity') continue;
        // Repository integrity, before anything of the project is dispatched (D1 §8.1 step 3).
        try {
          integrity(projectRow(p.id));
        } catch (err) {
          process.stderr.write(`integrity ${p.id}: ${err.stack}\n`);
          suppressed.add(p.id);
        }
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
  for (const r of all(`SELECT * FROM "runs" WHERE "state" IN ('claimed', 'executing', 'validating') AND "outcome" IS NULL`)) {
    // A run whose end is already decided is left to the retry of that end.
    if (live.get(r.id)?.intended) continue;
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
      tx(() => raiseDecision(project, kind, 'run', runId, ['confirm'], `Confirm ${kind} of run ${runId}.`));
      decision = decisionFor(kind, runId);
    }
    throw refusal(409, 'confirm_required', 'This needs a confirmation.', { decision: decision.id, preview_hash: decision.preview_hash });
  }
  // A run whose end the engine has already decided, for a deadline or because
  // its role exited, is not stopped any more: the outcome decided stands
  // (SEAM.md §24). An expired lease that no tick has acted on has decided
  // nothing, and the command is recorded as given (E28 item 2).
  const known = live.get(runId);
  if (known?.intended && !mutant('stop_replaces_decided_end')) throw refusal(409, 'illegal_transition', `the engine is already ending this run (${known.intended[0]})`, { run: runId });
  tx(() => {
    if (!mutant('stop_without_confirm')) {
      if (!decision || decision.preview_hash !== body.preview_hash) throw refusal(409, 'decision_stale', 'The preview hash is not the open decision\'s.');
      exec(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ?, "answer" = ? WHERE "id" = ?`, iso(), JSON.stringify({ option: 'confirm' }), decision.id);
      emit('decision.answered', { decision: decision.id, project });
      emit('decision.consumed', { decision: decision.id, project });
    }
    // The lease is closing before the request is answered.
    exec(`UPDATE "leases" SET "closing" = 1 WHERE "resource_id" = ? AND "released_at" IS NULL`, runId);
  });
  if (known) {
    known.intended = null;
    known.ending = null;
  }
  // The defect `expiry_beats_stop`: a command confirmed on an expired lease is recorded as a recovery.
  if (mutant('expiry_beats_stop') && leaseExpired(runId)) endRun(runId, 'recovered', 'recovered');
  else endRun(runId, outcome, reason);
  return { status: 200, body: { run: { id: runId } } };
}

function answer(project, decisionId, body) {
  const d = one('SELECT * FROM "decisions" WHERE "id" = ? AND "project" = ?', decisionId, project);
  if (!d) throw refusal(404, 'not_found', 'no such decision');
  if (d.status !== 'open') throw refusal(409, 'decision_consumed', 'The decision is not open.');
  if (d.preview_hash !== body.preview_hash) throw refusal(409, 'decision_stale', 'The preview hash differs.');
  if (!json(d.options).some((o) => o.key === body.option)) throw refusal(400, 'invalid_value', 'not an option', { field: 'option' });
  if (d.kind === 'out_of_band_change') return answerOob(project, d, body);
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
    if (post && s.length === 3) {
      // Arm a barrier, or arm it again, while the engine runs (SEAM.md §33).
      if (typeof body.name !== 'string' || !['pause', 'kill'].includes(body.action)) throw refusal(400, 'invalid_value', 'a barrier has a name and an action', { field: 'name' });
      opt.barriers.set(body.name, { action: body.action, state: 'armed', release: null });
      return { status: 200, body: { barriers: list() } };
    }
    const b = opt.barriers.get(decodeURIComponent(s[3]));
    if (!b || b.state !== 'waiting') throw refusal(409, 'illegal_transition', 'not a waiting barrier');
    b.release();
    return { status: 200, body: { barriers: list() } };
  }
  if (state.mode !== 'full') throw refusal(503, 'engine_starting', `restricted at ${state.step}`, { step: state.step });

  if (harnessRoute && post) {
    if (path === '/v1/harness/fixtures/project') {
      const id = newId('proj_');
      // A registered project without a bootstrap commit; its integration branch
      // is registered where it is, and a developer's checkout of it becomes a
      // managed checkout with what it holds as its baseline (SEAM.md §25).
      tx(() => {
        insert('projects', { id, created_at: iso(), name: body.name, paused: 0, tier: body.tier, dev_repo_path: body.dev_repo_path, integration_branch: body.integration_branch, registration_state: 'registered', policy: '{}' });
        emit('project.created', { project: id }, { ...FIXTURE, ...body });
        const p = projectRow(id);
        registerRef(id, integrationRef(p), 'integration', G.refOid(p.dev_repo_path, integrationRef(p)));
        registerCheckouts(p);
      });
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

  if (post && path === '/v1/projects') return createProject(body, { kind: 'human', request_id: requestId });
  if (s[1] === 'projects' && s.length >= 4) {
    const project = s[2];
    if (!one('SELECT 1 FROM "projects" WHERE "id" = ?', project)) throw refusal(404, 'not_found', 'no such project', { project });
    if (s.length === 4 && s[3] === 'policy') return get ? getPolicy(project) : changePolicy(project, body, { kind: 'human', request_id: requestId });
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
    const fail = (err) => send(err.status ?? 500, { code: err.code ?? 'store_error', reason: err.message, what_to_do: err.whatToDo ?? 'See SEAM.md.', subject: err.subject ?? {} });
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
    // Every registered repository is read before full mode (D1 §1.4 step 5).
    // The defect `startup_integrity_skipped`: the step only says it ran.
    if (!mutant('startup_integrity_skipped')) {
      for (const p of all('SELECT * FROM "projects" ORDER BY "id"')) {
        try {
          integrity(p);
        } catch (err) {
          process.stderr.write(`integrity ${p.id}: ${err.stack}\n`);
        }
      }
    }
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
