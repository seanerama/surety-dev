// Developer tests for M4 slice 29 (D4 §2.6; E129 item 8 as Sean decided it;
// the driver's rulings on the slice-29 design): the host's facts an adapter
// qualification is matched on, a qualification environment never taken up
// by the tick or an observation job, and an earlier run's leftovers refusing
// the next run by exact unit name.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { hostFactsDrift, hostFactsOf } = await import(join(dist, 'deploy', 'qualification.js'));
const { ADAPTER_QUALIFICATION_CASES } = await import(join(dist, 'deploy', 'qualify-cases.js'));
const { beginQualification, deployWork, endQualification } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { default: Database } = await import('better-sqlite3');

const host = (over = {}) => ({ host_id: 'h1', kernel: '6.6', tool_versions: JSON.stringify({ systemd: '255', ip: 'x' }), mechanism_fingerprint: 'm1', ...over });

test("a new host qualification row with the same facts keeps the match; each changed member is named, in order", () => {
  const then = hostFactsOf(host());
  assert.equal(hostFactsDrift(hostFactsOf(host()), then), null, 'a restart on an unchanged host');
  assert.equal(hostFactsDrift(hostFactsOf(host({ tool_versions: JSON.stringify({ ip: 'x', systemd: '255' }) })), then), null, 'the tool versions compared as values, not as text');
  assert.equal(hostFactsDrift(hostFactsOf(host({ mechanism_fingerprint: 'm2' })), then), 'mechanism_fingerprint');
  assert.equal(hostFactsDrift(hostFactsOf(host({ tool_versions: JSON.stringify({ systemd: '256', ip: 'x' }), mechanism_fingerprint: 'm2' })), then), 'tool_versions', 'the first member that differs');
  assert.equal(hostFactsDrift(hostFactsOf(host({ kernel: '6.7' })), then), 'kernel');
  assert.equal(hostFactsDrift(hostFactsOf(host({ host_id: 'h2' })), then), 'host_id');
  assert.equal(hostFactsDrift(null, null), null, 'null matches null (unrun)');
  assert.equal(hostFactsDrift(null, then), 'host_id', 'no host qualification in force is a change');
  assert.equal(hostFactsDrift(then, null), 'host_id');
});

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}

const CONTENT = { adapter: 'local_service', adapter_version: '1', targets: ['app'], runtime: { path: '/usr/bin/node', sha256: 'a'.repeat(64) }, start: ['/usr/bin/node', 'server.js'], port: 8080, identity_method: 'tree_digest' };
const begin = (db, incarnation = 'inc_1') =>
  transact(db, ENGINE_ACTOR, (tx) => beginQualification(tx, { adapter: 'local_service', adapterVersion: '1', project: 'proj_q', incarnation, homeHash: '0123456789ab', content: CONTENT, identity: 'sha256:x' }));

test('a qualification environment has no observation job, and its operations are never the tick\'s', (t) => {
  const db = store(t);
  const run = begin(db);
  assert.match(run.environment, /^env_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(run.prefix, `surety-0123456789ab-${run.environment}-`);
  assert.equal(db.prepare('SELECT "qualification_run" FROM "environments" WHERE "id" = ?').get(run.environment).qualification_run, run.run);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "observation_jobs" WHERE "environment" = ?').get(run.environment).n, 0, 'no observation job');
  const op = (id, frozen) => {
    db.prepare(
      `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status", "deadline_at", "finalizer_inputs", "orchestration_stage")
       VALUES (?, 'x', 'proj_q', ?, 'deploy', ?, '{}', ?, 1, 'intended', 'x', ?, 'effect')`,
    ).run(id, Number(id.slice(-1)), JSON.stringify({ environment: run.environment }), id, JSON.stringify(frozen));
    db.prepare(`INSERT INTO "deploy_journal_state" ("id", "created_at", "project", "operation", "journal_kind", "state", "last_event_seq") VALUES (?, 'x', 'proj_q', ?, 'deploy_apply', 'intended', 1)`).run(`djs_${id}`, id);
  };
  op('op_1', { purpose: 'deploy', qualification: run.run, environment: run.environment });
  op('op_2', { purpose: 'deploy', environment: run.environment });
  assert.deepEqual(deployWork(db, { project: 'proj_q' }).drive, ['op_2'], "the run's own operation is driven by the run only");
});

test('a second run is refused while one runs; an earlier run\'s unit left refuses the next by its exact name, and nothing is cleaned', (t) => {
  const db = store(t);
  const run = begin(db);
  assert.throws(() => begin(db), (err) => err.status === 409 && err.code === 'qualification_running');
  const cases = ADAPTER_QUALIFICATION_CASES.map((c) => ({ case: c, result: 'failed', control: 'passed', detail: { x: 1 } }));
  transact(db, ENGINE_ACTOR, (tx) => endQualification(tx, { run: run.run, cases, qualified: false, evidence: null }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "adapter_qualifications"').get().n, 0, 'a run that does not qualify records no row');
  const unit = `${run.prefix}g3.service`;
  db.prepare(`INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status", "deadline_at", "finalizer_inputs") VALUES ('op_9', 'x', 'proj_q', 9, 'deploy', ?, '{}', 'k9', 1, 'failed', 'x', '{}')`).run(
    JSON.stringify({ environment: run.environment }),
  );
  db.prepare(`INSERT INTO "operation_attempts" ("id", "created_at", "project", "operation", "attempt_number", "status", "started_at", "timeline", "reconciliation_reads") VALUES ('att_9', 'x', 'proj_q', 'op_9', 1, 'failed', 'x', '[]', '[]')`).run();
  db.prepare(`INSERT INTO "execution_domains" ("id", "created_at", "project", "attempt", "status", "profile", "launch_state", "unit") VALUES ('dom_9', 'x', 'proj_q', 'att_9', 'launched', 'service', 'authorized', ?)`).run(unit);
  assert.throws(
    () => begin(db),
    (err) => err.status === 409 && err.code === 'qualification_left_units' && JSON.stringify(err.subject.units) === JSON.stringify([unit]),
  );
  assert.equal(db.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get('dom_9').status, 'launched', 'nothing was touched');
  db.prepare(`UPDATE "execution_domains" SET "launch_state" = 'closed', "launch_closed_at" = 'x' WHERE "id" = 'dom_9'`).run();
  db.prepare(`UPDATE "execution_domains" SET "status" = 'terminated', "terminated_at" = 'x' WHERE "id" = 'dom_9'`).run();
  assert.ok(begin(db).run, 'once its domain is observed terminated, the next run begins');
});
