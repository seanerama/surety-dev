// Observations, out-of-band changes, the stored reads and the preempting
// teardown, for the M4 slice-27 rows, "tear down and observe" (M326 to
// M331, and the cases deferred here; SEAM.md §§290 to 298). The kernel-lane
// helpers drive the scripted deployment adapter (SEAM.md §247) and touch
// nothing on the host. The sandbox-lane helpers at the end act on units.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 297). The only units anything here
// creates or stops are a test's own **stray** units: named
// `surety-<h>-<env>-g<n>.service` with <h> the test's own home's hash, <env>
// one of its own environment ids and a generation no attempt intent of its
// store names; created by `systemd-run --user` under that exact name only
// after the manager reports it `not-found`, running `/usr/bin/sleep` with
// small limits; stopped only by that exact name, and only if this module
// created it and no attempt intent names it. Nothing here stops, restarts,
// reloads, re-executes or daemon-reloads the user manager, lists units with
// a pattern, or signals any process. A unit the engine created is acted on
// only through host.mjs (`stopOwnUnit`, `restartOwnUnit`, after
// `assertServiceContained`).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decision } from '../decisions.mjs';
import { eventsOfType } from '../journal.mjs';
import { waitFor } from '../engine.mjs';
import { advanceClock, tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { adapterState, artifactsOf, attemptsOf, environmentLeases, environmentRecord, homeHash, operationRow, operationsOf, scriptCall, unitName, unitPrefix } from './kernel.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

// ---- the observation job (SEAM.md §291) ---------------------------------------------------------

export const observationJob = (home, environment) => rows(home, 'SELECT * FROM "observation_jobs" WHERE "environment" = ?', environment)[0];

export const historyOf = (home, environment) =>
  rows(home, 'SELECT * FROM "observation_history" WHERE "environment" = ? ORDER BY "observed_at", rowid', environment).map((r) => ({
    ...r,
    detail: json(r.detail),
    read_interval: json(r.read_interval),
    facts: json(r.facts),
  }));

// The stored current observation of the environment record (SEAM.md §291).
export const observedOf = (home, environment) => environmentRecord(home, environment)?.observed ?? null;

// Advance the engine's clock by `seconds` (by default one past the default
// cadence) and ask for ticks until a new observation of `env` is recorded.
// The total advanced is kept on the fixture, for a restart's
// --harness-clock-offset (SEAM.md §274). Kernel lane.
export async function observe(ctx, env = ctx.env, { seconds = 31, max = 6, timeoutMs = 30_000 } = {}) {
  const { fx, project } = ctx;
  const before = historyOf(fx.home, env.id).length;
  await advanceClock(fx.engine, seconds);
  fx.clockAdvanced = (fx.clockAdvanced ?? 0) + seconds;
  const recorded = () => {
    const h = historyOf(fx.home, env.id);
    return h.length > before ? h.at(-1) : undefined;
  };
  // The observer runs off the tick (SEAM.md §291; objection 046): ticks are
  // asked for so it falls due, and the row is then waited for by time, so a
  // read that is held until its deadline still lands. `max` 0 asks for none.
  try {
    if (max > 0) return await tickUntil(fx.engine, project, recorded, { max, what: `an observation of ${env.name ?? env.id}` });
  } catch {
    // not within the ticks: by time below
  }
  if (max === 0) return recorded();
  return waitFor(recorded, { timeoutMs, what: `an observation of ${env.name ?? env.id}` });
}

// The same on a real unit: the ticks asked for in real time (host.mjs's ticksUntil).
export async function observeOnHost(ctx, env, ticksUntil, { seconds = 31, timeoutMs = 120_000 } = {}) {
  const { fx, project } = ctx;
  const before = historyOf(fx.home, env.id).length;
  await advanceClock(fx.engine, seconds);
  fx.clockAdvanced = (fx.clockAdvanced ?? 0) + seconds;
  return ticksUntil(
    fx,
    project,
    () => {
      const h = historyOf(fx.home, env.id);
      return h.length > before ? h.at(-1) : undefined;
    },
    { timeoutMs, what: `an observation of ${env.name}` },
  );
}

export const missedEvents = (home, environment) => eventsOfType(home, 'environment.observation_missed').filter((e) => e.subject?.environment === environment);
export const observedEvents = (home, environment) => eventsOfType(home, 'environment.observed').filter((e) => e.subject?.environment === environment);

// ---- the scripted adapter, by caller (SEAM.md §247, amended by §291) -------------------------

// Queue answers for the observation job's next calls of `call` (`by`: observation).
export const scriptObservation = (engine, environment, call, answers) => scriptCall(engine, environment, call, answers.map((a) => ({ ...a, by: 'observation' })));

export const callsBy = (state, call, by) => state.calls.filter((c) => c.call === call && c.by === by);

// Release every held read of the environment (the `hold` answer).
export async function releaseHeld(engine, environment) {
  const res = await engine.post(`/v1/harness/deploy/environments/${environment}/release`, {});
  assert.equal(res.status, 200, `the held reads of ${environment} are released (SEAM.md §247) (body: ${res.text})`);
}

// A `status` read's value (Appendix B, TargetInventory) as the scripted
// adapter would answer from `target`, with every target's source timestamp `at`.
export function statusValue(target, at) {
  return {
    complete: target.complete,
    inventory: [
      ...target.units.map((u) => ({
        resource: u.name,
        kind: 'unit',
        recorded: false,
        state: u.state,
        pendingJob: u.pending_job,
        generation: u.generation,
        invocation_id: u.invocation_id,
        cgroup: u.state === 'active' ? u.cgroup : null,
      })),
      ...(target.resources ?? []).map((r) => ({ resource: r.path, kind: r.kind, recorded: true, state: r.state, pendingJob: false, generation: r.generation })),
    ],
    targets: target.units.map((u) => ({
      target: 'app',
      unit: u.name,
      active: u.state === 'unread' ? 'unread' : u.state === 'active',
      instance: u.instance,
      generation: u.generation,
      supervision: 'attached',
      at,
    })),
  };
}

// A matching `verify` read of `unit` (Appendix B, IdentityRead[]) with its own source timestamp `at`.
export const verifyValue = (unit, at) => [{ target: 'app', method: 'tree_digest', expected: unit.tree, read: unit.tree, match: 'match', instance: unit.instance, generation: unit.generation, at }];

// ---- out-of-band changes (SEAM.md §293) ---------------------------------------------------------

export const oobRows = (home, environment) =>
  rows(home, `SELECT * FROM "out_of_band_changes" WHERE "subject_kind" = 'environment' AND "environment" = ? ORDER BY "detected_at", rowid`, environment).map((r) => ({
    ...r,
    expected: json(r.expected),
    found: json(r.found),
    acknowledged: json(r.acknowledged),
  }));

export const isOpen = (r) => r.disposition === null && r.closed_at === null;
export const openOob = (home, environment) => oobRows(home, environment).filter(isOpen);
export const oobEvents = (home, environment) => eventsOfType(home, 'environment.out_of_band').filter((e) => e.subject?.environment === environment);
export const oobDecision = (home, row) => decision(home, row.decision);

// What every out-of-band row of the environment must be (SEAM.md §293):
// subject environment, expected and found, a decision offering exactly
// `teardown` and `acknowledge`, and `environment.out_of_band` naming it.
export function assertOobRow(home, row, what) {
  assert.equal(row.subject_kind, 'environment', `${what}: the row's subject is the environment (J6)`);
  assert.ok(row.expected !== null && row.found !== null, `${what}: the row holds what was expected and what was found (${JSON.stringify(row)})`);
  const d = oobDecision(home, row);
  assert.ok(d, `${what}: the row names its decision`);
  assert.equal(d.kind, 'out_of_band_change', `${what}: the decision is out_of_band_change`);
  assert.deepEqual(d.options.map((o) => o.key).sort(), ['acknowledge', 'teardown'], `${what}: it offers teardown and acknowledge, and no adopt (D4 §6.3)`);
  const events = oobEvents(home, row.environment);
  assert.ok(events.some((e) => JSON.stringify([e.subject, e.payload]).includes(row.id)), `${what}: environment.out_of_band names the row`);
  return d;
}

// ---- the preempting teardown (SEAM.md §296) ------------------------------------------------------

export const requestPreempt = (engine, project, name, body = { preempt: true }) => engine.post(`/v1/projects/${project}/environments/${name}/teardown`, body);

// POST …/teardown {"preempt": true}: 202, naming the teardown operation. Returns its id.
export async function preempt(engine, project, name) {
  const res = await requestPreempt(engine, project, name);
  assert.equal(res.status, 202, `the preempting teardown of ${name} is accepted (SEAM.md §296) (body: ${res.text})`);
  const op = res.body?.teardown?.operation;
  assert.match(op ?? '', /^op_/, `the answer names the teardown operation (body: ${res.text})`);
  return op;
}

export const preemptedEvents = (home, operation) => eventsOfType(home, 'deploy.preempted').filter((e) => e.subject?.operation === operation);

// What the preemption's transaction left, read right after the 202
// (SEAM.md §296): launches closed, the lease passed with a higher
// generation, the teardown's linked_prior, deploy.preempted once.
export function assertPreemption(ctx, { deploy, teardownId, leaseBefore, envId = ctx.env.id }) {
  const { home } = ctx.fx;
  const teardown = operationRow(home, teardownId);
  assert.equal(teardown?.kind, 'teardown', 'the operation named is a teardown');
  assert.equal(teardown.linked_prior, deploy.id, `the preempted deploy is the teardown's linked_prior (D1 A.5; D4 §4.6) (${teardown.linked_prior})`);
  const events = preemptedEvents(home, deploy.id);
  assert.equal(events.length, 1, `deploy.preempted once for ${deploy.id} (D4 A.5) (${events.length})`);
  assert.ok(JSON.stringify([events[0].subject, events[0].payload]).includes(teardownId), 'deploy.preempted names the teardown');
  const ops = [...operationsOf(home, ctx.project, 'deploy'), ...operationsOf(home, ctx.project, 'teardown')].filter((o) => o.target?.environment === envId && o.id !== teardownId);
  for (const o of ops) for (const a of attemptsOf(home, o.id)) assert.ok(a.launch_state === null || a.launch_state === 'closed', `attempt ${a.attempt_number} of ${o.id}: its launch is closed (D4 §4.6 step 2) (${a.launch_state})`);
  const leases = environmentLeases(home, envId);
  const held = leases.filter((l) => l.released_at === null);
  assert.equal(held.length, 1, `one environment lease is held (${JSON.stringify(leases)})`);
  assert.ok(leaseBefore === undefined || leases.find((l) => l.id === leaseBefore.id)?.released_at, "the preempted operation's lease is released");
  assert.ok(leaseBefore === undefined || held[0].generation > leaseBefore.generation, `the lease passed with a higher generation (${leaseBefore?.generation} → ${held[0].generation})`);
  assert.equal(teardown.finalizer_inputs?.lease?.generation, held[0].generation, "the teardown's frozen intent names the lease it holds");
  return { teardown, lease: held[0] };
}

// ---- the stored reads (SEAM.md §294) -------------------------------------------------------------

export const logsRead = (engine, project, name) => engine.get(`/v1/projects/${project}/environments/${name}/logs`);
export const collectLogs = (engine, project, name) => engine.post(`/v1/projects/${project}/environments/${name}/logs`, {});

// What a stored read must leave unchanged: the highest event seq, the
// records, the environment record, the observation history and jobs.
export const storeFootprint = (home, environment) =>
  withStore(home, (db) => ({
    seq: db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n,
    records: db.prepare('SELECT COUNT(*) AS n FROM "records"').get().n,
    record: JSON.stringify(db.prepare('SELECT * FROM "environment_records" WHERE "environment" = ?').get(environment) ?? null),
    history: db.prepare('SELECT COUNT(*) AS n FROM "observation_history" WHERE "environment" = ?').get(environment).n,
    jobs: JSON.stringify(db.prepare('SELECT * FROM "observation_jobs" WHERE "environment" = ?').all(environment)),
  }));

// The footprint once the engine is quiet: two reads `intervalMs` apart
// that agree, within `timeoutMs`, else the case fails saying so (so the
// engine's own start-up or background work is not taken for a read's
// write). Returns the settled footprint.
export async function quietFootprint(home, environment, { intervalMs = 3000, timeoutMs = 60_000, what = 'the engine' } = {}) {
  const until = Date.now() + timeoutMs;
  let last = storeFootprint(home, environment);
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const now = storeFootprint(home, environment);
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    if (Date.now() > until) assert.fail(`${what} never settled: its store kept changing for ${timeoutMs} ms (events ${describeEventsSince(home, last.seq)}), so a read's write could not be told from its own work`);
    last = now;
  }
}

// Each event after `seq`, as its type and the kinds of its payload's members.
export function describeEventsSince(home, seq) {
  const events = withStore(home, (db) => db.prepare('SELECT "seq", "type", "subject", "payload" FROM "events" WHERE "seq" > ? ORDER BY "seq"').all(seq));
  return JSON.stringify(events.map((e) => {
    const payload = json(e.payload) ?? {};
    return { seq: e.seq, type: e.type, subject: Object.keys(json(e.subject) ?? {}), payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v])) };
  }));
}

// The reads wrote nothing: the footprint is unchanged; if not, the message
// names every new event by type and payload kind.
export function assertFootprintUnchanged(home, environment, before, what) {
  const after = storeFootprint(home, environment);
  assert.deepEqual(after, before, `${what}: nothing written (no event, record, observation or job changed); new events: ${describeEventsSince(home, before.seq)}`);
}

// ---- a byte changed in the sealed copy (SEAM.md §297; M306's practice) ---------------------------

export function changeSealedByte(home, project) {
  const [artifact] = artifactsOf(home, project);
  assert.ok(artifact?.path, 'the project has a sealed artifact');
  const name = readdirSync(artifact.path).includes('server.js') ? 'server.js' : readdirSync(artifact.path).find((n) => n.endsWith('.js'));
  const path = join(artifact.path, name);
  chmodSync(path, 0o644);
  appendFileSync(path, '// a byte changed by hand\n');
  return path;
}

// ---- the test's own stray units (sandbox lane; SEAM.md §297) -------------------------------------

// name → the home it was created for.
const strays = new Map();
const OWN = (home) => new RegExp(`^surety-${homeHash(home)}-env_[0-9A-HJKMNP-TV-Z]{26}-g(\\d+)\\.service$`);

function intended(home) {
  try {
    return withStore(home, (db) => db.prepare('SELECT "create_units" FROM "attempt_intents"').all()).flatMap((r) => json(r.create_units) ?? []);
  } catch {
    return null;
  }
}

function show(name) {
  const done = spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'ActiveState', '--', name], { encoding: 'utf8', timeout: 30_000 });
  if (done.status !== 0) return null;
  return Object.fromEntries(done.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

// Create a unit of this test's own home's prefix, of a generation no
// attempt intent names (90 or more), under its exact name. Fails closed: a
// name of another home, a generation an intent names, an unreadable store or
// a name already loaded is refused before anything is run.
export function createStrayUnit(home, environment, generation = 90) {
  assert.ok(Number.isInteger(generation) && generation >= 90, `a stray's generation is 90 or more (${generation})`);
  const name = unitName(home, environment, generation);
  assert.ok(OWN(home).test(name) && name.startsWith(unitPrefix(home, environment)), `the stray ${name} carries this test's own home's prefix for its own environment`);
  const named = intended(home);
  assert.ok(named !== null, 'the store\'s attempt intents can be read: otherwise nothing is created');
  assert.ok(!named.includes(name), `no attempt intent names ${name}`);
  const before = show(name);
  assert.equal(before?.LoadState, 'not-found', `the name ${name} is not in use (a name that exists is refused)`);
  const done = spawnSync('systemd-run', ['--user', `--unit=${name}`, '--quiet', '--collect', '--property=MemoryMax=16M', '--property=TasksMax=2', '/usr/bin/sleep', '3600'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.status, 0, `the stray ${name} is created (${done.stderr})`);
  strays.set(name, home);
  return name;
}

// Stop and remove a stray this module created, by its exact name. Refuses
// any other name, and a name an attempt intent of the store names.
export function removeStrayUnit(home, name) {
  assert.equal(strays.get(name), home, `${name} is a stray this test created for this home`);
  assert.ok(OWN(home).test(name), `${name} has the exact stray form`);
  const named = intended(home);
  assert.ok(named !== null && !named.includes(name), `no attempt intent names ${name}: it is the test's own, not the engine's`);
  spawnSync('systemctl', ['--user', 'stop', '--', name], { encoding: 'utf8', timeout: 60_000 });
  const after = show(name);
  if (after?.LoadState === 'loaded' && after?.ActiveState === 'failed') spawnSync('systemctl', ['--user', 'reset-failed', '--', name], { encoding: 'utf8', timeout: 30_000 });
  strays.delete(name);
  return show(name)?.LoadState ?? null;
}

// Every stray still loaded, removed by its exact name (for `finally`). Returns their names.
export function removeStrays(home) {
  const left = [...strays].filter(([, h]) => h === home).map(([n]) => n);
  for (const name of left) removeStrayUnit(home, name);
  return left;
}

export { adapterState, json };
