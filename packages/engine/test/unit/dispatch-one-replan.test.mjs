// Developer test for one replan run per project at a time (slice 37; the
// driver's ruling, extending ruling 1 on the protected-path writers): two
// replans of one project write the same phase plan's files, so under D6 K2
// the second waits, eligible, while the first runs, and is dispatchable once
// it has ended. Another project's replan is not held. Against a scratch store.

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
const { dispatchBlocker } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { holdReasonOf } = await import(join(dist, 'scheduler', 'holds.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-14T00:00:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  for (const p of ['prj_1', 'prj_2']) {
    db.prepare(
      `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
       VALUES (?, ?, ?, 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    ).run(p, AT, p);
  }
  let seq = 0;
  const item = (id, project) => {
    db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, ?, ?, 'replan', '{}', 'eligible', 'test', ?, 1, 0, 0, 0, 0)`,
    ).run(id, AT, project, ++seq, id);
    return () => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  };
  const runOf = (id, workItem, project, state) =>
    db.prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
       VALUES (?, ?, ?, ?, ?, 'architect', 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0)`,
    ).run(id, AT, project, ++seq, workItem, state, 'a'.repeat(40), AT);
  return { db, item, runOf };
}

test("a project's second replan waits while its first runs; dispatchable once it has ended; another project's is not held", (t) => {
  const { db, item, runOf } = store(t);
  const first = item('wi_r1', 'prj_1');
  const second = item('wi_r2', 'prj_1');
  const elsewhere = item('wi_r3', 'prj_2');
  assert.equal(dispatchBlocker(db, second(), { check: false }), null, 'with no replan under way, either may be dispatched');

  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = 'wi_r1'`).run();
  runOf('run_r1', 'wi_r1', 'prj_1', 'executing');
  const blocked = dispatchBlocker(db, second(), { check: false });
  assert.equal(blocked, 'depends on a replan running');
  assert.equal(holdReasonOf(blocked), 'depends_on', 'shown as a dependency hold');
  assert.equal(dispatchBlocker(db, elsewhere(), { check: false }), null, "another project's replan is not held");

  db.prepare(`UPDATE runs SET state = 'ended', outcome = 'completed' WHERE id = 'run_r1'`).run();
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_r1'`).run();
  assert.equal(first().status, 'complete');
  assert.equal(dispatchBlocker(db, second(), { check: false }), null, 'once the first has ended, the second is dispatched');
});
