// Developer tests for D5 (DECISIONS item 57; the owner's ruling of
// 2026-11-26: "Accept for recorded engine-blocked and explicitly paused
// intervals. Show total wall time, excluded time and reason, and time
// charged to the limit. Time spent waiting for an ordinary owner approval
// still counts unless the project is explicitly paused."): the runtime
// clock's recorded exclusions (store/transitions/prototype-clock.ts), the
// limit check that charges what is left, and the iteration read's
// `time.clock`.
//
// A scratch store with the engine's migrations; no engine, process, unit or
// host resource is started. Times are moved by writing the approval and the
// intervals in the past.

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
const { bootstrapProject, setPaused } = await import(join(dist, 'store', 'transitions', 'project.js'));
const { readIteration } = await import(join(dist, 'prototype', 'iterations.js'));
const P = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const C = await import(join(dist, 'store', 'transitions', 'prototype-clock.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {} });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-11-26T00:00:00.000Z';
const H = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-d5-'));
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
  // A rapid prototype building, its brief approved `approvedAgoMs` ago, its
  // runtime limit `runtime` seconds.
  const create = async (runtime, approvedAgoMs) => {
    const prepared = await prepareNewProject(rt, { name: 'Proto', idea: 'A small app.', dev_repo_path: join(dir, `app${++n}`), mode: 'rapid_prototype' });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    const row = db.prepare('SELECT limits_json FROM prototype_iterations WHERE id = ?').get(made.project.iteration);
    db.prepare(`UPDATE prototype_iterations SET limits_json = ?, status = 'building', approved_at = ?, next_step = 'none: building' WHERE id = ?`).run(
      JSON.stringify({ ...JSON.parse(row.limits_json), prototype_runtime_seconds: runtime }),
      ago(approvedAgoMs),
      made.project.iteration,
    );
    db.prepare(`UPDATE decisions SET status = 'consumed', consumed_at = ? WHERE project = ? AND kind = 'prototype_preparation_approval'`).run(AT, made.project.id);
    return made.project;
  };
  return { db, create };
}

// An interval recorded as the engine records one, its span written in the past.
function interval(db, project, iteration, reason, fromAgo, toAgo) {
  const from = ago(fromAgo);
  transact(db, ENGINE_ACTOR, (tx) => C.openExclusion(tx, { project, iteration, reason, cause_kind: 'test', cause_id: reason, from }));
  if (toAgo !== null) {
    const row = db.prepare(`SELECT id FROM prototype_clock_exclusions WHERE iteration = ? AND reason = ? AND to_at IS NULL`).get(iteration, reason);
    db.prepare(`UPDATE prototype_clock_exclusions SET to_at = ?, seconds = ? WHERE id = ?`).run(ago(toAgo), Math.round((fromAgo - toAgo) / 1000), row.id);
  }
}

const iterationRow = (db, id) => db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(id);
const verdictNow = (db, id) => P.iterationVerdict(db, iterationRow(db, id), { reservation: 0, repair: false, item_repairs: 0, work_item: null });

test('(c, e) no exclusion: the wall time is charged and the limit is reached; an ordinary owner wait is not excluded', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 5 * H);
  const v = verdictNow(db, p.iteration);
  assert.equal(v?.limit, 'runtime');
  assert.ok(v.facts.elapsed_seconds >= 5 * 3600 - 2);
  transact(db, ENGINE_ACTOR, (tx) => P.settleIterationRuntime(tx));
  assert.equal(iterationRow(db, p.iteration).status, 'limit_reached');
  const clock = readIteration(db, { project: p.id, iteration: p.iteration }).time.clock;
  assert.equal(clock.basis, 'recorded');
  assert.deepEqual(clock.excluded, []);
  assert.equal(clock.excluded_seconds, 0);
  assert.equal(clock.limit_seconds, 4 * 3600);
});

test('(a, b, f) recorded intervals are excluded once: overlapping parked and paused time is their union; only the excluded time took it past the limit, so no limit is reached', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 5 * H);
  // Paused 3 h ago to 1 h ago; parked 2 h ago to 30 min ago: union 2.5 h.
  interval(db, p.id, p.iteration, 'paused', 3 * H, 1 * H);
  interval(db, p.id, p.iteration, 'parked_on_blocker', 2 * H, 0.5 * H);
  assert.equal(verdictNow(db, p.iteration), null, '5 h wall less 2.5 h excluded is 2.5 h, under 4 h');
  transact(db, ENGINE_ACTOR, (tx) => P.settleIterationRuntime(tx));
  assert.equal(iterationRow(db, p.iteration).status, 'building');
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  const clock = read.time.clock;
  assert.equal(clock.basis, 'recorded');
  assert.deepEqual(clock.excluded.map((e) => e.reason).sort(), ['parked_on_blocker', 'paused']);
  assert.ok(Math.abs(clock.excluded_seconds - 2.5 * 3600) < 3, `union once: ${clock.excluded_seconds}`);
  assert.ok(Math.abs(clock.wall_seconds - 5 * 3600) < 3);
  assert.ok(Math.abs(clock.charged_seconds - 2.5 * 3600) < 3);
  for (const e of clock.excluded) assert.deepEqual(Object.keys(e).sort(), ['cause', 'from', 'open', 'reason', 'seconds', 'to']);
});

test('an open interval runs to now; the explicit pause and resume record it (setPaused)', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 1 * H);
  transact(db, HUMAN, (tx) => setPaused(tx, { project: p.id, paused: true }));
  let rows = db.prepare('SELECT * FROM prototype_clock_exclusions WHERE iteration = ?').all(p.iteration);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'paused');
  assert.equal(rows[0].to_at, null);
  // Pausing again records nothing more (one open interval per reason).
  transact(db, HUMAN, (tx) => setPaused(tx, { project: p.id, paused: true }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prototype_clock_exclusions WHERE iteration = ?').get(p.iteration).n, 1);
  transact(db, HUMAN, (tx) => setPaused(tx, { project: p.id, paused: false }));
  rows = db.prepare('SELECT * FROM prototype_clock_exclusions WHERE iteration = ?').all(p.iteration);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].to_at, null);
  assert.ok(rows[0].seconds >= 0);
});

test('(a) a parked work item opens parked_on_blocker from its blocker; its retry closes it; a planned project records nothing', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 5 * H);
  const blocker = JSON.stringify({ reason: 'repairs_exhausted', raised_at: ago(3 * H), decision: null });
  transact(db, ENGINE_ACTOR, (tx) => C.syncClockExclusions(tx, { id: p.iteration, project: p.id }, { id: 'wi_x', blocker }));
  let row = db.prepare(`SELECT * FROM prototype_clock_exclusions WHERE iteration = ? AND reason = 'parked_on_blocker'`).get(p.iteration);
  assert.equal(row.cause_id, 'wi_x');
  assert.equal(row.to_at, null);
  assert.ok(Math.abs(Date.parse(row.from_at) - (Date.now() - 3 * H)) < 5000, 'from the blocker');
  assert.equal(verdictNow(db, p.iteration), null, 'the open interval runs to now: 5 h less 3 h');
  transact(db, ENGINE_ACTOR, (tx) => C.syncClockExclusions(tx, { id: p.iteration, project: p.id }, null));
  row = db.prepare(`SELECT * FROM prototype_clock_exclusions WHERE iteration = ? AND reason = 'parked_on_blocker'`).get(p.iteration);
  assert.notEqual(row.to_at, null);
  assert.ok(Math.abs(row.seconds - 3 * 3600) < 5);
});

test('(f) an iteration recorded before migration 0053 serves basis not_recorded_before_0053 with excluded_seconds null, never 0', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 1 * H);
  const applied = db.prepare('SELECT applied_at FROM schema_migrations WHERE seq = 53').get().applied_at;
  db.prepare('UPDATE prototype_iterations SET created_at = ?, clock_basis = NULL WHERE id = ?').run(new Date(Date.parse(applied) - 86_400_000).toISOString(), p.iteration);
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  const clock = read.time.clock;
  assert.equal(clock.basis, 'not_recorded_before_0053');
  assert.equal(clock.excluded_seconds, null);
  assert.ok(typeof clock.wall_seconds === 'number');
  // Recorded as such it is `recorded` whatever its age.
  db.prepare(`UPDATE prototype_iterations SET clock_basis = 'recorded' WHERE id = ?`).run(p.iteration);
  assert.equal(C.clockBasisOf(db, { id: p.iteration }), 'recorded');
});

test('a provider refusal hold is recorded as a provider_refusal interval and charged as before', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 5 * H);
  interval(db, p.id, p.iteration, 'provider_refusal', 2 * H, 1 * H);
  const v = verdictNow(db, p.iteration);
  assert.equal(v?.limit, 'runtime', '5 h less 1 h is past 4 h');
  assert.match(v.reason, /held by a provider refusal/);
  assert.ok(Math.abs(v.facts.provider_hold_seconds - 3600) < 3);
});

test('before the approval the clock has not started', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 1 * H);
  db.prepare('UPDATE prototype_iterations SET approved_at = NULL WHERE id = ?').run(p.iteration);
  const clock = C.clockOf(db, iterationRow(db, p.iteration), 14400);
  assert.equal(clock.wall_seconds, null);
  assert.equal(clock.charged_seconds, null);
  assert.equal(clock.excluded_seconds, null);
});

test('stallOf: no open plan, no stall', async (t) => {
  const { db, create } = scratch(t);
  const p = await create(4 * 3600, 1 * H);
  assert.equal(C.stallOf(db, p.id), null);
});
