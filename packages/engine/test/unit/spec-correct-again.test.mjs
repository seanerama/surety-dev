// Developer tests for S3 (E173 item 4; Sean's ruling of 2026-10-20, option
// B; SEAM.md §557): the owner's command that registers a specification
// change's cancelled `spec_obligation` correction again, its refusals, and
// `GET …/spec`'s `change_requests` naming it. Against a scratch store with
// the engine's migrations.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { correctRequestAgain, correctCommand } = await import(join(dist, 'spec', 'change.js'));
const { specView } = await import(join(dist, 'plan', 'reads.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-20T00:00:00.000Z';
const EVIDENCE = { criteria: { affected: ['R2.1'], uncovered: [], removed: [] }, checks: ['accept-r2'], generation: 2 };

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  for (const p of ['p', 'q']) {
    run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES (?, ?, ?, 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`, p, AT, p);
  }
  run(`INSERT INTO spec_change_requests (id, created_at, project, seq, spec_revision, text, request_text, source, status) VALUES ('scr_1', ?, 'p', 1, 'sr_1', NULL, 'R2.1 content type', 'owner', 'approved')`, AT);
  run(`INSERT INTO check_obligations (id, created_at, project, "check", key, criteria, generation, reason, request) VALUES ('obl_1', ?, 'p', 'chk_1', 'accept-r2', '["R2.1"]', 2, 'spec_changed', 'scr_1')`, AT);
  return { db, run };
}

let seq = 0;
function correction(run, { id, generation, status }) {
  seq += 1;
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, trigger_evidence)
     VALUES (?, ?, 'p', ?, 'check_correction', '{"request":"scr_1"}', ?, 'spec_obligation', 'scr_1', ?, 0, 0, 0, 0, ?)`,
    id, AT, seq, status, generation, JSON.stringify(EVIDENCE),
  );
}

const correct = (db, project = 'p', request = 'scr_1') => transact(db, ENGINE_ACTOR, (tx) => correctRequestAgain(tx, { project, request }));
const refused = (fn, status, code) =>
  assert.throws(fn, (err) => {
    assert.deepEqual([err.status, err.code], [status, code]);
    return true;
  });
const corrections = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'check_correction' AND trigger_id = 'scr_1' ORDER BY trigger_generation`).all();

test('the command registers the cancelled correction again, at the next generation, with the same request, criteria and checks', () => {
  const { db, run } = store();
  correction(run, { id: 'wi_1', generation: 1, status: 'parked' });
  refused(() => correct(db), 409, 'correction_pending');
  db.prepare(`UPDATE work_items SET status = 'cancelled' WHERE id = 'wi_1'`).run();
  const out = correct(db);
  assert.equal(out.status, 201);
  const [, again] = corrections(db);
  assert.equal(out.body.work_item.id, again.id, 'the answer names the registered item');
  assert.deepEqual(
    [again.kind, again.status, again.trigger_source, again.trigger_id, again.trigger_generation, JSON.parse(again.subject).request],
    ['check_correction', 'eligible', 'spec_obligation', 'scr_1', 2, 'scr_1'],
  );
  assert.deepEqual(JSON.parse(again.trigger_evidence), EVIDENCE, 'the same criteria and checks');
  const created = db.prepare(`SELECT payload FROM events WHERE type = 'work.created' AND json_extract(subject, '$.work_item') = ?`).get(again.id);
  const payload = JSON.parse(created.payload);
  assert.equal(payload.from_work_item, 'wi_1');
  assert.ok(!('decision' in payload), 'no decision to name');
  refused(() => correct(db), 409, 'correction_pending');
  assert.equal(corrections(db).length, 2, 'the refusal registers nothing');
});

test('refused nothing_owed once the request owes nothing; 404 for an unknown request, another project\'s request, an unknown project', () => {
  const { db, run } = store();
  correction(run, { id: 'wi_1', generation: 1, status: 'complete' });
  refused(() => correct(db, 'p', 'scr_none'), 404, 'not_found');
  refused(() => correct(db, 'q', 'scr_1'), 404, 'not_found');
  refused(() => correct(db, 'p_none', 'scr_1'), 404, 'not_found');
  db.prepare(`UPDATE check_obligations SET resolved_at = ?, resolved_by = 'pv_1' WHERE id = 'obl_1'`).run(AT);
  refused(() => correct(db), 409, 'nothing_owed');
  assert.equal(corrections(db).length, 1, 'nothing registered');
});

test('GET …/spec lists a request with open obligations: the command after a cancel, the live correction while one is pending', () => {
  const { db, run } = store();
  correction(run, { id: 'wi_1', generation: 1, status: 'parked' });
  let [entry, ...more] = specView(db, { project: 'p' }).change_requests;
  assert.equal(more.length, 0);
  assert.equal(entry.id, 'scr_1');
  assert.deepEqual(entry.open_obligations.map((o) => [o.id, o.key, o.criteria]), [['obl_1', 'accept-r2', ['R2.1']]]);
  assert.deepEqual(entry.next_action, { kind: 'correction_pending', work_item: 'wi_1', status: 'parked' });
  db.prepare(`UPDATE work_items SET status = 'cancelled' WHERE id = 'wi_1'`).run();
  [entry] = specView(db, { project: 'p' }).change_requests;
  assert.equal(entry.next_action.command, correctCommand('p', 'scr_1'));
  assert.equal(correctCommand('p', 'scr_1'), 'surety spec correct --project p --request scr_1');
  db.prepare(`UPDATE check_obligations SET criteria = 'not json' WHERE id = 'obl_1'`).run();
  [entry] = specView(db, { project: 'p' }).change_requests;
  assert.ok(entry.open_obligations[0].criteria.unknown, 'unreadable criteria are unknown, never empty');
  db.prepare(`UPDATE check_obligations SET resolved_at = ? WHERE id = 'obl_1'`).run(AT);
  assert.deepEqual(specView(db, { project: 'p' }).change_requests, [], 'a request that owes nothing is not listed');
});

test('surety spec correct: a usage problem exits 2 before anything is asked', () => {
  const cli = (args) => spawnSync(process.execPath, [join(dist, 'cli.js'), 'spec', ...args], { encoding: 'utf8', env: { ...process.env, SURETY_HOME: '/nonexistent-surety-home' } });
  for (const args of [['correct', '--project', 'p'], ['correct', '--request', 'r'], ['correct', '--project', 'p', '--request', 'r', '--file', 'f'], ['correct', '--project', 'p', '--project', 'q', '--request', 'r'], ['nonsense']]) {
    const out = cli(args);
    assert.equal(out.status, 2, `${args.join(' ')}: ${out.stderr}`);
  }
});
