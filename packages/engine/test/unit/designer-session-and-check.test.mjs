// Developer tests for slice 41 (the Designer session and the design
// check): a Designer's own fixture read against B.8's shapes; the plan
// check's clause 5 (targets and technologies); a turn's result outside B.12
// named by its field; the Designer's own session budget key.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { shapeProblem, fixtureProblem } = await import(join(dist, 'design', 'shape.js'));
const { technologyAdmits } = await import(join(dist, 'plan', 'check.js'));
const { sessionReplyProblem } = await import(join(dist, 'sessions', 'session.js'));
const { runBudgetKey } = await import(join(dist, 'store', 'transitions', 'ledger.js'));

const ITEM = { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 }, quantity: { type: 'integer', minimum: 0, maximum: 99 } }, required: ['name', 'quantity'] };
const LIST = { type: 'object', properties: { items: { type: 'array', collection: true, items: ITEM } }, required: ['items'] };
const INV = {
  interfaces: [
    { name: 'list-items', response: LIST, request: { type: 'null' }, errors: [] },
    { name: 'add-item', response: ITEM, request: ITEM, errors: [{ code: 'name_taken', when: 'taken' }] },
  ],
  fixtures: [
    { interface: 'list-items', state: 'ok', path: 'inventory/fixtures/list-items.ok.json' },
    { interface: 'list-items', state: 'loading', path: 'inventory/fixtures/list-items.loading.json' },
    { interface: 'add-item', state: 'error:name_taken', path: 'inventory/fixtures/add-item.error:name_taken.json' },
    { interface: 'add-item', state: 'invalid_input', path: 'inventory/fixtures/add-item.invalid_input.json' },
  ],
};
const buf = (v) => Buffer.from(JSON.stringify(v));

test('a value against B.8: types, required, closed properties, bounds', () => {
  assert.equal(shapeProblem({ items: [{ name: 'rice', quantity: 2 }] }, LIST, { bounds: true }), null);
  assert.match(shapeProblem({ items: [{ name: 'rice', quantity: 'two' }] }, LIST, { bounds: true }), /quantity: string/);
  assert.match(shapeProblem({ items: [{ name: 'rice' }] }, LIST, { bounds: true }), /required property "quantity"/);
  assert.match(shapeProblem({ items: [], extra: 1 }, LIST, { bounds: true }), /"extra" is not a property/);
  assert.match(shapeProblem({ name: 'x', quantity: 100 }, ITEM, { bounds: true }), /above its maximum/);
  assert.equal(shapeProblem({ name: 'x', quantity: 100 }, ITEM, { bounds: false }), null);
});

test('a file under mockups/data/: named as an inventory fixture and valid as that fixture is', () => {
  assert.equal(fixtureProblem('list-items.ok.json', buf({ items: [{ name: 'rice', quantity: 2 }] }), INV), null);
  assert.match(fixtureProblem('list-items.ok.json', buf({ items: [{ name: 'rice', quantity: 'two' }] }), INV), /string/);
  assert.equal(fixtureProblem('list-items.loading.json', buf(null), INV), null);
  assert.equal(fixtureProblem('add-item.error:name_taken.json', buf({ code: 'name_taken', message: 'taken' }), INV), null);
  assert.match(fixtureProblem('add-item.error:name_taken.json', buf({ code: 'other', message: 'x' }), INV), /code/);
  assert.equal(fixtureProblem('add-item.invalid_input.json', buf({ name: '', quantity: -1 }), INV), null);
  assert.match(fixtureProblem('add-item.nothing.json', buf({}), INV), /not named/);
  assert.match(fixtureProblem('list-items.ok.json', Buffer.from('{'), INV), /not JSON/);
  assert.match(fixtureProblem('list-items.ok.json', buf({ items: [] }), null), /no recorded inventory/);
});

test('D7 §4.1 admissibility: exactly the table; other on every target', () => {
  const targets = ['web', 'android', 'ios', 'macos', 'windows', 'linux'];
  const admitted = (tech) => targets.filter((t) => technologyAdmits(tech, t));
  assert.deepEqual(admitted('html_css'), ['web']);
  assert.deepEqual(admitted('three_js'), ['web']);
  assert.deepEqual(admitted('streamlit'), ['web']);
  assert.deepEqual(admitted('react_native'), ['android', 'ios']);
  assert.deepEqual(admitted('flutter'), targets);
  assert.deepEqual(admitted('swiftui'), ['ios', 'macos']);
  assert.deepEqual(admitted('compose'), ['android']);
  assert.deepEqual(admitted('other'), targets);
  assert.deepEqual(admitted('cobol'), []);
});

test('a turn result outside B.12 is named by its field; findings only for the Designer', () => {
  const base = { status: 'completed', summary: 's', reply: 'r', artifact_changed: false };
  assert.equal(sessionReplyProblem(base, 'designer'), null);
  assert.match(sessionReplyProblem({ ...base, mood: 'calm' }, 'designer'), /"mood" is not a field/);
  assert.match(sessionReplyProblem({ ...base, findings: [] }, 'architect'), /"findings" is not a field/);
  assert.equal(sessionReplyProblem({ ...base, findings: [{ category: 'contract_conflict', severity: 'low', message: 'm', interface: 'add-item' }] }, 'designer'), null);
  assert.match(sessionReplyProblem({ ...base, findings: [{ category: 'retry', severity: 'low', message: 'm' }] }, 'designer'), /"findings"/);
  assert.match(sessionReplyProblem('text', 'designer'), /not a JSON object/);
});

test('a Designer session budgets on designer_session_budget_billable_tokens; every other run on the run budget', () => {
  assert.equal(runBudgetKey({ kind: 'session', role: 'designer' }), 'designer_session_budget_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'session', role: 'architect' }), 'budget_run_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'one_shot', role: 'builder' }), 'budget_run_billable_tokens');
});

// ---- a Designer turn held on the day limits (the driver's decision on objection 156) ---------------

const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { exhaustedLimits } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { dispatchBlocker, expiredRunLeases } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { releaseHeldTurn, heldTurns, sessionView } = await import(join(dist, 'sessions', 'session.js'));
const { default: Database } = await import('better-sqlite3');

const P = 'proj_held';
// A project whose day has, in flight, two Builders (1,500,000 reserved each,
// nothing observed) against budget_day_unknown_tokens 2,000,000, and a
// Designer session whose turn 1 was admitted held.
function heldFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES (?, ?, 'held', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(P, at);
  const run = (id, role, kind, seq) =>
    db.prepare(`INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "session_state", "work_item", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined") VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?, 'scripted', '1', 'opus', 'r', '2099-01-01T00:00:00.000Z', 0)`).run(id, at, P, seq, role, kind, kind === 'session' ? 'turn_running' : null, kind === 'session' ? null : `wi_${id}`);
  const receipt = (id, runId, turn, snapshot) =>
    db.prepare(`INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot") VALUES (?, ?, ?, ?, ?, 'scripted', 'opus', 'g', ?)`).run(id, at, P, runId, turn, JSON.stringify(snapshot));
  run('run_b1', 'builder', 'one_shot', 1);
  run('run_b2', 'builder', 'one_shot', 2);
  receipt('inv_b1', 'run_b1', null, { budget_run_billable_tokens: 1_500_000 });
  receipt('inv_b2', 'run_b2', null, { budget_run_billable_tokens: 1_500_000 });
  run('run_d', 'designer', 'session', 3);
  db.prepare(`INSERT INTO "turns" ("id", "created_at", "project", "run", "number", "invocation", "domain", "started_at", "day_hold") VALUES ('turn_d1', ?, ?, 'run_d', 1, 'inv_d1', 'dom_d1', ?, ?)`).run(at, P, at, JSON.stringify({ limits: ['budget_day_unknown_tokens'], since: at }));
  receipt('inv_d1', 'run_d', 'turn_d1', { budget_run_billable_tokens: 1_500_000, designer_session_budget_billable_tokens: 3_000_000 });
  db.prepare(`INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "closing", "cleanup_authority") VALUES ('lease_d', ?, 'run', 'run_d', 'inc', 1, ?, ?, '2000-01-01T00:00:00.000Z', 0, 0)`).run(at, at, at);
  db.prepare(`INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold") VALUES ('wi_later', ?, ?, 1, 'fix', '{}', 'eligible', 'test', 't1', 1, 0, 0, 0, 0)`).run(at, P);
  const end = (inv) => db.prepare(`INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at") VALUES (?, ?, ?, ?, 1, 'ended', ?)`).run(`iso_${inv}`, at, P, inv, at);
  return { db, end };
}

test('a held turn is not its own reservation; it stays held while the in-flight Builders pass the day limit, and is released once they end', (t) => {
  const { db, end } = heldFixture(t);
  assert.deepEqual(exhaustedLimits(db, P, { check: false, dispatch: true }), ['budget_day_unknown_tokens'], 'the day passed with every reservation');
  assert.deepEqual(exhaustedLimits(db, P, { check: false, dispatch: true, exclude: 'inv_d1' }), ['budget_day_unknown_tokens'], 'and without the held turn\'s: the two Builders alone (3,000,000)');
  let out = transact(db, ENGINE_ACTOR, (tx) => releaseHeldTurn(tx, { run: 'run_d', invocation: 'inv_d1' }));
  assert.equal(out.released, false, 'still held');
  assert.equal(heldTurns(db, P).length, 1, 'the project lists the held turn');
  const view = sessionView(db, P, 'run_d');
  assert.equal(view.turns[0].state, 'held', 'the session read shows the turn held');
  assert.deepEqual(view.turns[0].held.limits, ['budget_day_unknown_tokens'], 'naming the limit');
  assert.equal(view.run.held?.turn, 1, 'and the session itself held on that turn');
  assert.deepEqual(expiredRunLeases(db, '2050-01-01T00:00:00.000Z').map((r) => r.run), [], 'a held turn owns no process: its expired lease is not reconciled');
  end('inv_b1');
  out = transact(db, ENGINE_ACTOR, (tx) => releaseHeldTurn(tx, { run: 'run_d', invocation: 'inv_d1' }));
  assert.equal(out.released, true, 'one Builder ended: 1,500,000 reserved without the turn, within the limit, released');
  assert.equal(heldTurns(db, P).length, 0, 'no longer listed');
  assert.notEqual(db.prepare('SELECT "day_hold_released_at" FROM "turns" WHERE "id" = ?').get('turn_d1').day_hold_released_at, null, 'its release recorded');
  assert.ok(db.prepare('SELECT "deadline_at" FROM "runs" WHERE "id" = ?').get('run_d').deadline_at < '2099', 'its deadline starts from the release');
  assert.ok(db.prepare('SELECT "expires_at" FROM "leases" WHERE "id" = ?').get('lease_d').expires_at > '2000-01-02', 'its lease renewed from the release');
  assert.equal(sessionView(db, P, 'run_d').turns[0].state, 'running');
});

test('fairness: while a Designer turn is held, no one-shot of its project is dispatched; once released, the day check alone decides', (t) => {
  const { db, end } = heldFixture(t);
  const item = db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get('wi_later');
  assert.match(dispatchBlocker(db, item, { check: false }) ?? '', /Designer turn of session run_d, held on the day limit/, 'the one-shot waits behind the held turn');
  end('inv_b1');
  end('inv_b2');
  assert.match(dispatchBlocker(db, item, { check: false }) ?? '', /held on the day limit/, 'still behind it, though the day now admits it: the turn goes first');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => releaseHeldTurn(tx, { run: 'run_d', invocation: 'inv_d1' })).released, true);
  assert.equal(dispatchBlocker(db, item, { check: false }), 'budget exhausted', 'released and in flight, the turn reserves the session\'s remaining 3,000,000: the one-shot waits on the day limit itself');
});

test('a Designer turn reserves what its session has left of its budget, never less than unknown', (t) => {
  const { db, end } = heldFixture(t);
  end('inv_b1');
  end('inv_b2');
  // An earlier turn of the session charged 2,500,000: 500,000 left.
  db.prepare(`INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "raw_usage", "normalization_version", "billable_in", "out", "usage_complete", "cost_status", "day_utc")
              VALUES ('led_0', ?, ?, 'inv_d0', 'run_d', 'turn_d0', 'designer', 'scripted', 'opus', '{}', 'scripted-1', 2400000, 100000, 1, 'unknown', '1999-01-01')`).run(new Date().toISOString(), P);
  assert.deepEqual(exhaustedLimits(db, P, { check: false, dispatch: true }), [], '500,000 reserved: within the day limit');
});
