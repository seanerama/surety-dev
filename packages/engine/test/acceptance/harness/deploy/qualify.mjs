// The adapter qualification by command, its rows, evidence and lapse, for
// the M4 slice-29 rows M338, M307 (f), M339 and M340 (SEAM.md §§321 to
// 324). The qualification itself is the engine's: it creates its own
// qualification environment, deploys its own fixture artifacts A and B
// through the real launcher, init and launch authorization, and removes
// everything it created (D4 §2.6).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 322). Nothing here creates, stops,
// restarts or resets a unit, signals a process or writes to a cgroup: the
// qualification's units are the engine's, created and removed by it through
// its own adapter under this test home's prefix, and the test only reads
// them afterwards by that prefix (a listing filtered in JavaScript). The one
// host command run here besides the engine's own CLI is `<tool> --version`
// of `systemd-run` and `systemctl`, which prints a version and touches no
// manager. The CLI is run with this test's own SURETY_HOME only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { CLI } from '../engine.mjs';
import { eventsOfType } from '../journal.mjs';
import { recordFile, recordRow } from '../records.mjs';
import { withStore } from '../store.mjs';
import { configContent, configure, requestDeployment } from './kernel.mjs';
import { cgroupsNamed, listUnits, requestLong } from './host.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

// D4 §2.6's nine cases, in D4 A.2's order (AdapterQualificationCase); the
// order the answer and the row list them in (SEAM.md §323).
export const ADAPTER_CASES = Object.freeze(['deploy_read_back', 'replace', 'receipt_lost', 'not_issued', 'late_launcher', 'out_of_band', 'unreadable', 'refused', 'teardown']);

// The engine's own `local_service` version in M4 (SEAM.md §322 †), which the
// configurations name.
export const LOCAL_SERVICE_VERSION = '1';

// The members a forged capability names in the `refused` case, as
// `deploy.capability_refused` names them (D4 §2.6 `refused`; SEAM.md §315's
// member names): another environment, another digest, another unit name (a
// create or a stop list), a stale attempt, a stale lease generation.
export const REFUSED_MEMBERS = Object.freeze([['environment'], ['artifact_digest'], ['create_units', 'stop_units'], ['attempt'], ['lease_generation']]);

// ---- the command and the route (SEAM.md §322) ---------------------------------------------------

// POST /v1/adapters/:a/qualify, waited for until the run has ended (it
// answers when every case is recorded). Returns the response.
export const qualifyRoute = (engine, adapter = 'local_service', { timeoutMs = 900_000 } = {}) => requestLong(engine, 'POST', `/v1/adapters/${adapter}/qualify`, {}, timeoutMs);

// The route, asserted to have answered 200 with the run's outcome. Returns the answer's body.
export async function qualifyAdapter(engine, adapter = 'local_service') {
  const res = await qualifyRoute(engine, adapter);
  assert.equal(res.status, 200, `POST /v1/adapters/${adapter}/qualify answers the run's outcome (SEAM.md §322) (→ ${res.status} ${res.text.slice(0, 600)})`);
  assertAnswerForm(res.body);
  return res.body;
}

// `surety qualify-adapter <adapter>` in the test's own home: the CLI over the
// route (SEAM.md §322). Returns {status, body, stdout, stderr}.
export function qualifyByCommand(fx, adapter = 'local_service', { timeoutMs = 900_000 } = {}) {
  const done = spawnSync(process.execPath, [CLI, 'qualify-adapter', adapter], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, body, stdout: done.stdout ?? '', stderr: done.stderr ?? '', error: done.error };
}

// The answer's form (SEAM.md §322): {qualified, adapter, adapter_version,
// adapter_qualification, cases, evidence, environment}.
export function assertAnswerForm(body, what = 'the qualification') {
  assert.equal(typeof body?.qualified, 'boolean', `${what}: the answer says whether the adapter is qualified (${JSON.stringify(body)?.slice(0, 400)})`);
  assert.equal(body.adapter, 'local_service', `${what}: the answer names the adapter`);
  assert.equal(typeof body.adapter_version, 'string', `${what}: the answer names the adapter version it qualified`);
  assert.deepEqual((body.cases ?? []).map((c) => c.case), [...ADAPTER_CASES], `${what}: the answer lists D4 §2.6's nine cases, in order (SEAM.md §323) (${JSON.stringify((body.cases ?? []).map((c) => c.case))})`);
  assert.match(body.environment ?? '', /^env_[0-9A-HJKMNP-TV-Z]{26}$/, `${what}: the answer names its qualification environment, an env_<ULID> (SEAM.md §322)`);
  if (body.qualified) {
    assert.match(body.adapter_qualification ?? '', /^aq_/, `${what}: a qualified run names its current row`);
    assert.match(body.evidence ?? '', /^rec_/, `${what}: and its qualification_evidence record`);
  }
  else assert.equal(body.adapter_qualification ?? null, null, `${what}: a run that does not qualify names no row`);
}

export const caseEntry = (body, name) => (body.cases ?? []).find((c) => c.case === name);

// ---- rows, events, evidence -----------------------------------------------------------------

export const adapterQualifications = (home) =>
  rows(home, 'SELECT * FROM "adapter_qualifications" ORDER BY rowid').map((r) => ({ ...r, cases: json(r.cases), label: json(r.label) }));
export const qualificationRow = (home, id) => adapterQualifications(home).find((r) => r.id === id) ?? null;
export const currentRows = (home, adapter = 'local_service') => adapterQualifications(home).filter((r) => r.adapter === adapter && r.status === 'current');

export const qualifiedEvents = (home) => eventsOfType(home, 'adapter.qualified');
export const lapsedEvents = (home, id) => eventsOfType(home, 'adapter.qualification_lapsed').filter((e) => id === undefined || e.subject?.adapter_qualification === id);
export const maxSeq = (home) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
export const eventsSince = (home, type, seq) => eventsOfType(home, type).filter((e) => e.seq > seq);

// The qualification_evidence record's bytes, parsed (SEAM.md §322).
export function evidenceOf(home, id) {
  const record = recordRow(home, id);
  assert.ok(record, `the evidence record ${id} exists`);
  assert.equal(record.kind, 'qualification_evidence', `the evidence is a qualification_evidence record (D4 §2.6) (${record.kind})`);
  return { record, content: JSON.parse(readFileSync(recordFile(home, record)).toString('utf8')) };
}

// The engine incarnations of the home: [{id, pid, started_at, ended_at}].
export const incarnationsOf = (home) => rows(home, 'SELECT "id", "pid", "started_at", "ended_at" FROM "engine_incarnations" ORDER BY "started_at", rowid');

// The first line `<tool> --version` prints (read only; it touches no manager).
export function toolVersionLine(tool) {
  const done = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return (done.stdout ?? '').split('\n')[0].trim() || null;
}

// The units the store's attempt intents name under a prefix.
export const intendedUnder = (home, prefix) =>
  rows(home, 'SELECT "create_units" FROM "attempt_intents"')
    .flatMap((r) => json(r.create_units) ?? [])
    .filter((u) => u.startsWith(prefix));

// ---- the probe of J4's rule (SEAM.md §324) ----------------------------------------------------

// A configuration with no identity method, so a deployment request to it is
// never satisfied (IDENTITY_METHOD_MISSING) and nothing is ever issued or
// deployed: its reasons say, beside that, whether the adapter is qualified
// for it (ADAPTER_UNQUALIFIED; SEAM.md §249: the reasons are independent).
export function probeContent(over = {}) {
  const content = configContent(over);
  delete content.identity_method;
  return content;
}

export async function probeEnvironment(engine, project, name = 'probe', over = {}) {
  const done = await configure(engine, project, name, probeContent(over));
  return { ...done.environment, name };
}

// The reasons of a deployment request to the probe environment, which is
// always refused: {codes, unqualified}.
export async function probeReasons(engine, project, candidate, name = 'probe') {
  const res = await requestDeployment(engine, project, candidate, name);
  assert.equal(res.status, 409, `a request to ${name}, which declares no identity method, is never satisfied (→ ${res.status} ${res.text.slice(0, 400)})`);
  const codes = [...new Set((res.body?.subject?.reasons ?? []).map((r) => r.code ?? r))].sort();
  assert.ok(codes.includes('IDENTITY_METHOD_MISSING'), `the fixture is live: the probe is refused for its missing identity method (${codes.join(', ')})`);
  return { codes, unqualified: codes.includes('ADAPTER_UNQUALIFIED') || res.body?.code === 'adapter_unqualified' };
}

// ---- runs, their environments, a stop and a kill mid-run (SEAM.md §§328 to 330) ----------------

// The engine's record of each `qualify-adapter` run (the Builder's table, the
// driver's ruling that a run which does not qualify is recorded only here).
export const qualificationRuns = (home) =>
  rows(home, 'SELECT * FROM "adapter_qualification_runs" ORDER BY "started_at", rowid').map((r) => ({ ...r, cases: json(r.cases) }));

// The environment a run made for itself: {id, name, project, prefix, qualification_run}.
export const qualificationEnvironment = (home, run) =>
  rows(home, 'SELECT "id", "name", "project", "prefix", "qualification_run" FROM "environments" WHERE "qualification_run" = ?', run)[0] ?? null;

// Wait, reading the store only, until a running qualification has deployed
// a service whose application started (an attempt of its environment with
// `app_instance` recorded): a point inside the run, with a qualification
// operation open and a unit of its prefix live. Returns {run, environment, attempt}.
export function untilQualificationServiceStarted(fx, { timeoutMs = 300_000 } = {}) {
  return waitForStore(
    () => {
      const running = qualificationRuns(fx.home).find((r) => r.status === 'running');
      if (!running) return undefined;
      const env = qualificationEnvironment(fx.home, running.id);
      if (!env) return undefined;
      const attempt = rows(
        fx.home,
        `SELECT a."id", a."app_instance" FROM "operation_attempts" a JOIN "operations" o ON o."id" = a."operation" WHERE json_extract(o."target", '$.environment') = ? AND a."app_instance" IS NOT NULL ORDER BY a.rowid`,
        env.id,
      )[0];
      return attempt ? { run: running, environment: env, attempt } : undefined;
    },
    { timeoutMs, what: 'a running qualification to have started a service' },
  );
}

async function waitForStore(probe, { timeoutMs, what, intervalMs = 50 }) {
  // A monotonic deadline (objection 052: this host's wall clock steps).
  const until = performance.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = probe();
    } catch {
      v = undefined;
    }
    if (v !== undefined) return v;
    if (performance.now() > until) throw new Error(`${what} was not reached within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// SIGTERM to the test's own engine child (an orderly stop), by the handle
// the harness spawned, after reading from /proc that it is the engine of
// this test's home (as recover.mjs's killOwnEngine reads it for SIGKILL);
// any read that fails or disagrees refuses, and nothing is signalled. Waits
// up to `graceMs` for it to exit by itself; returns {status, inTime}, and
// never sends anything more (the caller decides).
export async function terminateOwnEngine(fx, { graceMs = 60_000 } = {}) {
  const engine = fx.engine;
  assert.ok(engine && engine.isRunning(), 'the engine to stop is running');
  const pid = engine.pid;
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `the engine child's pid is a host pid of its own (${pid})`);
  assert.equal(engine.proc.child.pid, pid, 'the pid is the ChildProcess handle the harness spawned');
  let cmdline;
  let environ;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch (err) {
    assert.fail(`the engine child's /proc/${pid} cannot be read (${err.code}): nothing is signalled`);
  }
  assert.ok(cmdline.includes('serve'), `pid ${pid} is a surety engine (${cmdline.join(' ')})`);
  assert.ok(environ.includes(`SURETY_HOME=${fx.home}`), `pid ${pid} is this test's engine; nothing is signalled otherwise`);
  engine.proc.child.kill('SIGTERM');
  const status = await Promise.race([engine.exited, new Promise((r) => setTimeout(() => r(null), graceMs))]);
  return { status, inTime: status !== null };
}

// What is left of a prefix on the host, read only: loaded units (by a
// listing filtered here), cgroups, and files under $SURETY_HOME/run/ naming the environment.
export function leftOnHost(home, env) {
  const units = (listUnits() ?? null)?.filter((u) => u.unit.startsWith(env.prefix)).map((u) => u.unit) ?? null;
  let runFiles = [];
  try {
    runFiles = readdirSync(join(home, 'run'), { recursive: true }).filter((n) => String(n).includes(env.id) || String(n).includes(env.prefix));
  } catch {
    runFiles = [];
  }
  return { units, cgroups: cgroupsNamed(env.prefix), runFiles };
}

// The operator's exact teardown of a qualification environment:
// `surety env teardown <name> --project <its project>` (no --preempt), then
// ticks of that project until a teardown operation of the environment made
// after the command is finalized with its latest attempt applied. Returns
// {cli, op, attempt}.
export async function exactTeardown(fx, env, ticksUntil, { timeoutMs = 240_000 } = {}) {
  const ofEnv = () => rows(fx.home, `SELECT "id", "finalized_at" FROM "operations" WHERE "kind" = 'teardown' AND json_extract("target", '$.environment') = ? ORDER BY "seq"`, env.id);
  const earlier = new Set(ofEnv().map((o) => o.id));
  const done = spawnSync(process.execPath, [CLI, 'env', 'teardown', env.name, '--project', env.project], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SURETY_HOME: fx.home } });
  const cli = { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
  assert.equal(cli.status, 0, `surety env teardown ${env.name} --project ${env.project} is accepted (stdout ${cli.stdout.slice(0, 300)}; stderr ${cli.stderr.slice(0, 300)})`);
  return ticksUntil(
    fx,
    env.project,
    () => {
      const op = ofEnv().find((o) => !earlier.has(o.id) && o.finalized_at);
      if (!op) return undefined;
      const latest = rows(fx.home, 'SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"', op.id).map((a) => ({ ...a, reconciliation_reads: json(a.reconciliation_reads) })).at(-1);
      return latest && ['succeeded', 'reconciled_succeeded'].includes(latest.status) ? { cli, op, attempt: latest } : undefined;
    },
    { timeoutMs, what: `the exact teardown of ${env.name} to be applied` },
  );
}
