// F8 (E170): a design preview's domain's memory.peak (D7 §14; E156 Q4),
// read from the unit's own cgroup before the engine's stop removes it,
// recorded on the service domain at its closure and kept on the preview's
// row by the teardown (or the replacing deploy), with the event. Unread:
// nothing recorded, the pace read `unknown`, never zero.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { serviceDomainClosed, previewTornDown, previewDeployed } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { readPeak } = await import(join(dist, 'boundary', 'terminate.js'));
const { designPace } = await import(join(dist, 'design', 'pace.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { default: Database } = await import('better-sqlite3');

const ENV = 'env_01M6AAAAAAAAAAAAAAAAAAAAAA';
const PREFIX = `surety-0123456789ab-${ENV}-`;
const unitOf = (g) => `${PREFIX}g${g}.service`;

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "deployment_generation", "prefix") VALUES (?, 'x', 'proj_p', 'design-preview', 'local_service', 'environment_configs', '{}', 1, ?)`).run(ENV, PREFIX);
  return db;
}

function domain(db, id, unit) {
  db.prepare(
    `INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "attempt", "status", "profile", "launch_state", "unit", "cgroup_path") VALUES (?, 'x', 'proj_p', NULL, NULL, ?, 'launched', 'service', 'closed', ?, ?)`,
  ).run(id, `att_${id}`, unit, `/sys/fs/cgroup/user.slice/${unit}`);
}

// The preview's own deploy operation and the attempt whose service domain
// `dom` is (written after the closure: the closure itself reads only the domain).
let seq = 0;
function deployOf(db, dom, previewId, kind = 'deploy') {
  seq += 1;
  db.prepare(
    `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status", "deadline_at", "finalizer_inputs", "orchestration_stage")
     VALUES (?, 'x', 'proj_p', ?, ?, ?, ?, ?, 1, 'intended', 'x', '{}', 'ended')`,
  ).run(`op_${dom}`, seq, kind, JSON.stringify({ environment: ENV }), JSON.stringify({ design_preview: previewId, artifact_digest: 'sha256:x' }), `key_${dom}`);
  db.prepare(
    `INSERT INTO "operation_attempts" ("id", "created_at", "project", "operation", "attempt_number", "status", "started_at", "finished_at", "timeline", "reconciliation_reads", "incarnation", "deployment_generation", "capability", "launch_state")
     VALUES (?, 'x', 'proj_p', ?, 1, 'started', 'x', NULL, '[]', '[]', 'inc_1', 1, '{}', NULL)`,
  ).run(`att_${dom}`, `op_${dom}`);
}

function preview(db, id, g, status, unit) {
  db.prepare(`INSERT INTO "design_previews" ("id", "created_at", "project", "generation", "revision", "tree_digest", "server_digest", "unit", "port", "status", "mockups") VALUES (?, 'x', 'proj_p', ?, 'r', 't', 's', ?, 9000, ?, '[]')`).run(id, g, unit, status);
}

const events = (db, type) => db.prepare('SELECT "subject", "payload" FROM "events" WHERE "type" = ? ORDER BY "seq"').all(type).map((e) => ({ subject: JSON.parse(e.subject), payload: JSON.parse(e.payload) }));
const peakOf = (db, table, id) => db.prepare(`SELECT "memory_peak" FROM "${table}" WHERE "id" = ?`).get(id).memory_peak;

test('readPeak: a positive integer read from memory.peak; unreadable, empty, zero or not a number is null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cg = (name, text) => {
    const p = join(dir, name);
    mkdirSync(p);
    if (text !== null) writeFileSync(join(p, 'memory.peak'), text);
    return p;
  };
  assert.equal(readPeak(cg('a', '41943040\n')), 41_943_040);
  assert.equal(readPeak(cg('b', '0\n')), null, 'zero is not a peak');
  assert.equal(readPeak(cg('c', 'max\n')), null);
  assert.equal(readPeak(cg('d', '')), null);
  assert.equal(readPeak(cg('e', null)), null, 'no file: unread');
  assert.equal(readPeak(join(dir, 'gone')), null, 'no cgroup: unread');
});

test("a service domain's closure records the peak its stop read, once, with domain.peak_recorded; unread is unknown; a closure only observed records none", (t) => {
  const db = store(t);
  domain(db, 'dom_read', unitOf(1));
  domain(db, 'dom_unread', unitOf(2));
  domain(db, 'dom_observed', unitOf(3));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_read', observed: 'stopped', resource_events: null, memory_peak: 52_428_800 }));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_unread', observed: 'stopped', resource_events: null, memory_peak: null }));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_observed', observed: 'the cgroup is gone' }));
  assert.equal(peakOf(db, 'execution_domains', 'dom_read'), 52_428_800);
  assert.equal(peakOf(db, 'execution_domains', 'dom_unread'), null, 'unread: no value, never zero');
  const rec = events(db, 'domain.peak_recorded');
  assert.deepEqual(
    rec.map((e) => [e.subject.domain, e.payload.memory_peak]),
    [
      ['dom_read', 52_428_800],
      ['dom_unread', { unknown: "memory.peak of the unit's cgroup could not be read before its stop" }],
    ],
  );
  const observed = db.prepare('SELECT "memory_peak", "peak_recorded_at", "status" FROM "execution_domains" WHERE "id" = ?').get('dom_observed');
  assert.deepEqual(observed, { memory_peak: null, peak_recorded_at: null, status: 'terminated' }, 'a closure only observed: nothing read, nothing recorded');
  for (const id of ['dom_read', 'dom_unread']) assert.equal(db.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get(id).status, 'terminated');
});

test("the teardown keeps the preview domain's peak on the preview's row and in design.preview_torn_down; the pace read shows it", (t) => {
  const db = store(t);
  preview(db, 'dpv_1', 1, 'deployed', unitOf(1));
  domain(db, 'dom_1', unitOf(1));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_1', observed: 'stopped', memory_peak: 33_554_432 }));
  deployOf(db, 'dom_1', 'dpv_1');
  // Another preview's domain is not this preview's.
  domain(db, 'dom_other', unitOf(9));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_other', observed: 'stopped', memory_peak: 99_999_999 }));
  deployOf(db, 'dom_other', 'dpv_other');
  transact(db, ENGINE_ACTOR, (tx) => previewTornDown(tx, { project: 'proj_p', operation: 'op_none', reason: 'stop' }));
  assert.equal(peakOf(db, 'design_previews', 'dpv_1'), 33_554_432);
  const [ev] = events(db, 'design.preview_torn_down');
  assert.equal(ev.payload.memory_peak, 33_554_432);
  assert.deepEqual([ev.payload.generation, ev.payload.reason], [1, 'stop']);
  const pv = designPace(db, 'proj_p').previews;
  assert.equal(pv[0].memory_peak, 33_554_432, 'the pace read shows the recorded value');
});

test('a teardown whose stop did not read the peak records none: the row stays null, the event and the pace read say unknown', (t) => {
  const db = store(t);
  preview(db, 'dpv_1', 1, 'deployed', unitOf(1));
  domain(db, 'dom_1', unitOf(1));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_1', observed: 'stopped', memory_peak: null }));
  deployOf(db, 'dom_1', 'dpv_1');
  transact(db, ENGINE_ACTOR, (tx) => previewTornDown(tx, { project: 'proj_p', operation: 'op_none', reason: 'approved' }));
  assert.equal(peakOf(db, 'design_previews', 'dpv_1'), null);
  const [ev] = events(db, 'design.preview_torn_down');
  assert.equal(typeof ev.payload.memory_peak?.unknown, 'string', `unknown with its reason (${JSON.stringify(ev.payload.memory_peak)})`);
  const pv = designPace(db, 'proj_p').previews;
  assert.notEqual(pv[0].memory_peak, 0);
  assert.equal(typeof pv[0].memory_peak, 'object', 'unknown, never zero');
});

test("a newer preview's deploy replaces the earlier: the earlier's domain peak (read at the deploy's stop of it) is kept on its row and named in design.preview_deployed", (t) => {
  const db = store(t);
  preview(db, 'dpv_1', 1, 'deployed', unitOf(1));
  preview(db, 'dpv_2', 2, 'deploying', null);
  domain(db, 'dom_1', unitOf(1));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_1', observed: 'stopped', memory_peak: 20_971_520 }));
  deployOf(db, 'dom_1', 'dpv_1');
  transact(db, ENGINE_ACTOR, (tx) => previewDeployed(tx, { preview: 'dpv_2', unit: unitOf(2), identity_reads: [], operation: 'op_2', attempt: 'att_2' }));
  assert.equal(db.prepare('SELECT "status" FROM "design_previews" WHERE "id" = ?').get('dpv_1').status, 'torn_down');
  assert.equal(peakOf(db, 'design_previews', 'dpv_1'), 20_971_520);
  assert.equal(peakOf(db, 'design_previews', 'dpv_2'), null, 'the running one has no peak yet');
  const [ev] = events(db, 'design.preview_deployed');
  assert.deepEqual(ev.payload.replaced, [{ design_preview: 'dpv_1', generation: 1, memory_peak: 20_971_520 }]);
  assert.equal(events(db, 'design.preview_torn_down').length, 0, 'a replacement is not a teardown (no event)');
});

test("a failed preview whose unit ran (no unit on its row) keeps its own deploy domain's peak at the teardown", (t) => {
  const db = store(t);
  preview(db, 'dpv_1', 1, 'failed', null);
  domain(db, 'dom_1', unitOf(1));
  transact(db, ENGINE_ACTOR, (tx) => serviceDomainClosed(tx, { domain: 'dom_1', observed: 'stopped', memory_peak: 16_777_216 }));
  deployOf(db, 'dom_1', 'dpv_1');
  transact(db, ENGINE_ACTOR, (tx) => previewTornDown(tx, { project: 'proj_p', operation: 'op_none', reason: 'failed_preview' }));
  assert.equal(peakOf(db, 'design_previews', 'dpv_1'), 16_777_216);
  assert.equal(events(db, 'design.preview_torn_down')[0].payload.memory_peak, 16_777_216);
});
