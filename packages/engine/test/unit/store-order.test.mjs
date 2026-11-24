// Developer tests for DECISIONS item 51 (Sean's go of 2026-11-24): where the
// engine decided which of two facts came first, it compared two wall-clock
// stamps written by different transactions; a host clock that steps back
// (SEAM.md §23, §425) inverted the answer. Each comparison now reads one
// shared, durable order, the store's event seq (migration 0052), and a pair
// recorded before that order existed is compared by its timestamps under a
// named fallback (`timestamp_fallback`).
//
// Finding 2: what ended an observation (observe.ts observationEnd; the
// environment read and the project read's environments).
//
// Against a scratch store (foreign keys off, the rows the minimum each read
// needs). The controlled clock is the engine's own (testing/seam.ts, the
// cell `POST /v1/harness/clock/advance` moves, SEAM.md §425), stepped back
// in-process. Where a column of migration 0052 is absent (the base, before
// the fix) the rows are written without it, so the same file reproduces the
// defect there.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const txModule = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { transact, ENGINE_ACTOR } = txModule;
const { writeConfigVersion } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { observationLapsed, ensureObservationJob } = await import(join(dist, 'store', 'transitions', 'observe.js'));
const { readProject, readOneEnvironment } = await import(join(dist, 'store', 'projections.js'));
const { configureWorker } = await import(join(dist, 'testing', 'seam.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

// The engine's controlled clock, stepped back as a host's wall clock can be.
const clockCell = new SharedArrayBuffer(8);
configureWorker({ harness: false, barriers: [], shared: null, clock: clockCell, scripted: null, probes: {}, hostChecks: { mode: 'unrun', forced: {} } }, () => {});
const offset = new BigInt64Array(clockCell);
const stepBack = (seconds) => Atomics.add(offset, 0, BigInt(-seconds * 1000));
const clockReset = (t) => t.after(() => Atomics.store(offset, 0, 0n));

const AT = '2026-11-24T00:00:00.000Z';
const HEX = 'a'.repeat(64);

const hasColumn = (db, table, column) => db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-order-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo-missing', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  return db;
}

// ---- finding 2: what ended an observation -------------------------------------------------------

const MAP = {
  version: 1,
  modules: [{ name: 'api', paths: ['server.mjs'], sensitive_areas: [], interfaces: [{ name: 'notes', kind: 'http', path: '/notes', description: 'the notes' }], surface: 'api' }],
  mapping_from_spec: [],
};
const SPEC = {
  header: { spec_version: 1, status: 'approved', tier: 'T2', owner: 'o' },
  requirements: [],
  index: [],
  questions: [],
  modules: [],
  claims: [],
  environments: [{ name: 'alpha', fields: { Purpose: 'Alpha', 'Runtime and start command': 'node server.mjs' } }],
  targets: ['web'],
};
const SERVICE = { adapter: 'local_service', adapter_version: '1', targets: ['alpha'], runtime: { path: '/usr/bin/node', sha256: HEX }, start: ['node', 'server.mjs'], port: 8080 };

// A configured environment `alpha` with its observation job, generation 1.
function environment(t) {
  const db = store(t);
  db.prepare(`INSERT INTO spec_semantics (id, created_at, project, git_blob, representation, readable) VALUES ('ss_1', ?, 'prj_1', 'b', ?, 1)`).run(AT, JSON.stringify(SPEC));
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, semantics, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'b', 'd', 'ss_1', 'human', ?)`).run(AT, AT);
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('ar_1', ?, 'prj_1', 1, '{}', ?, '[]', 'human', ?)`).run(AT, JSON.stringify(MAP), AT);
  transact(db, { actor_kind: 'human', actor_id: 'owner', request_id: null }, (tx) =>
    writeConfigVersion(tx, { project: 'prj_1', name: 'alpha', content: SERVICE, identity: 'sha256:alpha', secretDigests: [], homeHash: 'abcdefabcdef', tree: null }),
  );
  const env = db.prepare(`SELECT id FROM environments WHERE name = 'alpha' AND prefix IS NOT NULL`).get().id;
  db.prepare('UPDATE environments SET current_generation = 1 WHERE id = ?').run(env);
  transact(db, ENGINE_ACTOR, (tx) => ensureObservationJob(tx, { environment: env, project: 'prj_1' }));
  return { db, env };
}

// An observation recorded by the engine's own transition (observationLapsed:
// insertHistory and writeObserved, as every observation), its stored
// condition then set healthy, so the read has a healthy current one to end.
function observe(db, env) {
  db.prepare('UPDATE observation_jobs SET lapse_reported = NULL, last_success_at = ? WHERE environment = ?').run(`x${Math.random()}`, env);
  const { observation } = transact(db, ENGINE_ACTOR, (tx) => observationLapsed(tx, { environment: env }));
  const rec = JSON.parse(db.prepare('SELECT observed FROM environment_records WHERE environment = ?').get(env).observed);
  db.prepare('UPDATE environment_records SET observed = ? WHERE environment = ?').run(JSON.stringify({ ...rec, condition: 'healthy' }), env);
  return { id: observation, observed_at: rec.observed_at };
}

// A teardown or deployment of the environment finalized now, as
// deploy.ts finalizeDeploy finalizes one: finalized_at, its
// operation.finalized event, and (after the fix) that event's seq.
let opSeq = 0;
function finalize(db, env, { kind, generation }) {
  opSeq += 1;
  const id = `op_${kind}_${opSeq}`;
  const at = transact(db, ENGINE_ACTOR, (tx) => {
    tx.db
      .prepare(
        `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs)
         VALUES (?, ?, 'prj_1', ?, ?, ?, '{}', ?, 1, 'succeeded', ?, '{}')`,
      )
      .run(id, tx.at, opSeq, kind, JSON.stringify({ environment: env }), `k${opSeq}`, tx.at);
    tx.db.prepare(`INSERT INTO operation_attempts (id, created_at, project, operation, attempt_number, status, started_at, deployment_generation, reconciliation_reads) VALUES (?, ?, 'prj_1', ?, 1, 'succeeded', ?, ?, '[]')`).run(`att_${opSeq}`, tx.at, id, tx.at, generation);
    tx.db.prepare('UPDATE operations SET finalized_at = ? WHERE id = ?').run(tx.at, id);
    const ev = tx.emit('operation.finalized', { project: 'prj_1', operation: id }, { journal_kind: kind === 'deploy' ? 'deploy_apply' : 'teardown_apply' });
    if (typeof txModule.finalizedInOrder === 'function') txModule.finalizedInOrder(tx, id, ev);
    return tx.at;
  });
  return { id, finalized_at: at };
}

const envRead = (db) => readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment;
const listed = (db) => readProject(db, { project: 'prj_1' }).project.environments.find((e) => e.name === 'alpha');

test('item 51 finding 2: the observation records its place in the store order, and a finalization its event seq', (t) => {
  const { db, env } = environment(t);
  const before = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get().s;
  const o = observe(db, env);
  const row = db.prepare('SELECT seq FROM observation_history WHERE id = ?').get(o.id);
  const observedEvent = db.prepare(`SELECT seq FROM events WHERE type = 'environment.observed' AND json_extract(subject, '$.observation') = ?`).get(o.id).seq;
  assert.ok(row.seq >= before && row.seq < observedEvent, `the row follows every event before it and precedes its own environment.observed (${before} <= ${row.seq} < ${observedEvent})`);
  const op = finalize(db, env, { kind: 'teardown', generation: 1 });
  const fin = db.prepare(`SELECT seq FROM events WHERE type = 'operation.finalized' AND json_extract(subject, '$.operation') = ?`).get(op.id).seq;
  assert.equal(db.prepare('SELECT finalized_seq FROM operations WHERE id = ?').get(op.id).finalized_seq, fin);
});

test('item 51 finding 2 (a): a healthy observation, the clock steps back, a teardown finalized: the read serves it ended by that teardown at once, by store order', (t) => {
  clockReset(t);
  const { db, env } = environment(t);
  const o = observe(db, env);
  assert.equal(envRead(db).observed.condition, 'healthy', 'the fixture is live: healthy and current before the teardown');
  stepBack(5);
  const op = finalize(db, env, { kind: 'teardown', generation: 1 });
  assert.ok(op.finalized_at < o.observed_at, `the clock stepped back: finalized_at ${op.finalized_at} is earlier than observed_at ${o.observed_at}`);
  for (const [where, observed, state] of [
    ['the environment read', envRead(db).observed, null],
    ['the project read', listed(db).observed, listed(db).state],
  ]) {
    assert.equal(observed.ended_by?.kind, 'teardown', `${where}: ended by the teardown (${JSON.stringify(observed)})`);
    assert.equal(observed.ended_by.operation, op.id, where);
    assert.equal(observed.ended_by.order_basis, 'seq', where);
    assert.equal(observed.order_basis, 'seq', where);
    assert.equal(observed.condition, 'unknown', where);
    assert.equal(observed.freshness, 'expired', where);
    if (state !== null) assert.equal(state, 'unknown', `${where}: the state as after a teardown`);
  }
});

test('item 51 finding 2 (b): replacement: the old observation ended by the replacing deployment; a later observation of the new generation is current, the clock stepped back again', (t) => {
  clockReset(t);
  const { db, env } = environment(t);
  observe(db, env);
  stepBack(5);
  const op = finalize(db, env, { kind: 'deploy', generation: 2 });
  db.prepare('UPDATE environments SET current_generation = 2 WHERE id = ?').run(env);
  const ended = envRead(db).observed;
  assert.deepEqual([ended.ended_by?.kind, ended.ended_by?.operation, ended.order_basis], ['deployment', op.id, 'seq'], JSON.stringify(ended));
  // The new generation's observation, the clock stepped back once more so
  // its observed_at is earlier than the deployment's finalized_at.
  stepBack(5);
  const next = observe(db, env);
  assert.ok(next.observed_at < op.finalized_at, `observed_at ${next.observed_at} is earlier than finalized_at ${op.finalized_at}`);
  for (const observed of [envRead(db).observed, listed(db).observed]) {
    assert.equal(observed.ended_by, undefined, `the new generation's observation is current (${JSON.stringify(observed)})`);
    assert.equal(observed.condition, 'healthy');
    assert.equal(observed.freshness, 'fresh');
    assert.equal(observed.order_basis, 'seq');
  }
  assert.equal(listed(db).state, 'healthy');
});

// Rows written directly: the observation and the finalization stamped the
// same millisecond, the store order deciding (c); or recorded before the
// order existed (d).
function storedObservation(db, env, { id, at, seq }) {
  const withSeq = seq !== undefined && hasColumn(db, 'observation_history', 'seq');
  db.prepare(
    `INSERT INTO observation_history (id, created_at, project, environment, observed_at, source, condition, detail, read_interval, expected_revision, deployment_generation, facts, installed${withSeq ? ', seq' : ''})
     VALUES (?, ?, 'prj_1', ?, ?, 'observation_job', 'healthy', NULL, '{}', 1, 1, '{}', 1${withSeq ? ', ?' : ''})`,
  ).run(id, at, env, at, ...(withSeq ? [seq] : []));
  const observed = { id, environment: env, condition: 'healthy', detail: null, observed_at: at, source: 'observation_job', read_interval: { from: at, to: at }, expected_revision: 1, deployment_generation: 1, facts: {} };
  if (db.prepare('UPDATE environment_records SET observed = ? WHERE environment = ?').run(JSON.stringify(observed), env).changes === 0) {
    db.prepare(`INSERT INTO environment_records (id, created_at, project, environment, observed) VALUES ('er_1', ?, 'prj_1', ?, ?)`).run(at, env, JSON.stringify(observed));
  }
}
function storedFinalization(db, env, { id, kind, at, seq }) {
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs, finalized_at)
     VALUES (?, ?, 'prj_1', ?, ?, ?, '{}', ?, 1, 'succeeded', ?, '{}', ?)`,
  ).run(id, at, ++opSeq, kind, JSON.stringify({ environment: env }), `k${opSeq}`, at, at);
  if (seq !== undefined && hasColumn(db, 'operations', 'finalized_seq')) db.prepare('UPDATE operations SET finalized_seq = ? WHERE id = ?').run(seq, id);
  db.prepare(`INSERT INTO operation_attempts (id, created_at, project, operation, attempt_number, status, started_at, deployment_generation, reconciliation_reads) VALUES (?, ?, 'prj_1', ?, 1, 'succeeded', ?, 1, '[]')`).run(`att_${id}`, at, id, at);
}

test('item 51 finding 2 (c): the observation and the finalization stamped the same millisecond: the store order decides both ways', (t) => {
  const { db, env } = environment(t);
  observe(db, env);
  const at = new Date(Date.now() - 1000).toISOString();
  // Finalized after the observation (seq 1001 > 1000), the same stamp.
  storedObservation(db, env, { id: 'obsh_eq', at, seq: 1000 });
  storedFinalization(db, env, { id: 'op_eq_after', kind: 'teardown', at, seq: 1001 });
  const after = envRead(db).observed;
  assert.deepEqual([after.ended_by?.kind, after.ended_by?.operation, after.order_basis], ['teardown', 'op_eq_after', 'seq'], `finalized after it in the store order, the same millisecond: ended (${JSON.stringify(after)})`);
  // Observed after a finalization of the same millisecond (seq 1002 > 1001).
  storedObservation(db, env, { id: 'obsh_eq2', at, seq: 1002 });
  const current = envRead(db).observed;
  assert.equal(current.ended_by, undefined, `observed after it in the store order, the same millisecond: current (${JSON.stringify(current)})`);
  assert.equal(current.order_basis, 'seq');
});

test('item 51 finding 2 (d): rows recorded before the store order existed are compared by their timestamps, and the read names that fallback', (t) => {
  const { db, env } = environment(t);
  const at = new Date(Date.now() - 2000).toISOString();
  const later = new Date(Date.now() - 1000).toISOString();
  storedObservation(db, env, { id: 'obsh_old', at });
  const unended = envRead(db).observed;
  assert.equal(unended.ended_by, undefined);
  assert.equal(unended.order_basis, 'timestamp_fallback', 'an observation with no recorded order: the basis is named, never seq');
  storedFinalization(db, env, { id: 'op_old', kind: 'teardown', at: later });
  for (const observed of [envRead(db).observed, listed(db).observed]) {
    assert.deepEqual([observed.ended_by?.kind, observed.ended_by?.order_basis, observed.order_basis], ['teardown', 'timestamp_fallback', 'timestamp_fallback'], JSON.stringify(observed));
  }
  // A new observation (with its order) against that old finalization (none): still the fallback, named.
  storedObservation(db, env, { id: 'obsh_new', at: new Date().toISOString(), seq: 5000 });
  const mixed = envRead(db).observed;
  assert.deepEqual([mixed.ended_by, mixed.order_basis], [undefined, 'timestamp_fallback'], JSON.stringify(mixed));
});
