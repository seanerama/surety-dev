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
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
// The scripted backend is a role's default only in the test mode (the
// owner's production-defaults ruling of 2026-10-27): a case that releases a
// held turn onto it runs in that mode.
const testMode = (t) => {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
};

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
  assert.match(sessionReplyProblem({ ...base, findings: [{ category: 'retry', severity: 'low', message: 'm' }] }, 'designer'), /findings\[0\]\.category is not/);
  assert.match(sessionReplyProblem('text', 'designer'), /not a JSON object/);
});

test('a Designer session budgets on designer_session_budget_billable_tokens; every other run on the run budget', () => {
  assert.equal(runBudgetKey({ kind: 'session', role: 'designer' }), 'designer_session_budget_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'session', role: 'architect' }), 'budget_run_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'one_shot', role: 'builder' }), 'budget_run_billable_tokens');
});


// ---- a scratch store --------------------------------------------------------------------------------

const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { exhaustedLimits, unknownAllowance } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { dispatchBlocker, expiredRunLeases } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { releaseHeldTurn, heldTurnsNow, sessionView } = await import(join(dist, 'sessions', 'session.js'));
const { recordDesignFindings } = await import(join(dist, 'design', 'findings.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { default: Database } = await import('better-sqlite3');

const P = 'proj_held';
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, domain_memory_max: 8 * 1024 ** 3, max_concurrent_domains: 8 });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES (?, ?, 'held', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(P, at);
  const run = (id, role, kind, seq, extra = {}) =>
    db
      .prepare(
        `INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "session_state", "work_item", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined", "turn_count", "grant")
         VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?, 'scripted', '1', 'opus', 'r', '2099-01-01T00:00:00.000Z', 0, ?, 'grant_x')`,
      )
      .run(id, at, P, seq, role, kind, kind === 'session' ? (extra.session_state ?? 'turn_running') : null, kind === 'session' ? null : `wi_${id}`, extra.turn_count ?? 0);
  const receipt = (id, runId, turn, snapshot, extra = {}) =>
    db
      .prepare(`INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot", "trust_entry") VALUES (?, ?, ?, ?, ?, 'scripted', 'opus', 'g', ?, ?)`)
      .run(id, at, P, runId, turn, JSON.stringify(snapshot), extra.trust_entry ?? null);
  const end = (inv) => db.prepare(`INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at") VALUES (?, ?, ?, ?, 1, 'ended', ?)`).run(`iso_${inv}`, at, P, inv, at);
  return { db, at, run, receipt, end };
}

// ---- B1: a Designer turn's unknown allowance ------------------------------------------------------------

test('an incomplete Designer turn is charged what its session has left less what it observed, prior spend subtracted once', (t) => {
  const { db, at, run, receipt } = scratch(t);
  run('run_d', 'designer', 'session', 1, { turn_count: 2 });
  db.prepare(`INSERT INTO "turns" ("id", "created_at", "project", "run", "number", "invocation", "domain", "started_at") VALUES ('turn_1', ?, ?, 'run_d', 1, 'inv_1', 'dom_1', ?), ('turn_2', ?, ?, 'run_d', 2, 'inv_2', 'dom_2', ?)`).run(at, P, at, at, P, at);
  const snap = { budget_run_billable_tokens: 1_500_000, designer_session_budget_billable_tokens: 3_000_000 };
  receipt('inv_1', 'run_d', 'turn_1', snap, { trust_entry: 'tr_x' });
  receipt('inv_2', 'run_d', 'turn_2', snap, { trust_entry: 'tr_x' });
  // Turn 1 was charged 1,600,000.
  db.prepare(
    `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "raw_usage", "normalization_version", "billable_in", "out", "usage_complete", "cost_status", "day_utc")
     VALUES ('led_1', ?, ?, 'inv_1', 'run_d', 'turn_1', 'designer', 'scripted', 'opus', '{}', 'n', 1500000, 100000, 1, 'unknown', '2026-10-17')`,
  ).run(at, P);
  // Turn 2 incomplete, 200,000 observed: 3,000,000 − 1,600,000 − 200,000.
  assert.equal(unknownAllowance(db, 'inv_2', P, { billable_in: 150_000, cached_in: 0, out: 50_000 }, 1, true), 1_200_000);
});

// ---- the hold (objection 156 (a); the review's S1, N3) -----------------------------------------------

// Two Builders in flight (1,500,000 reserved each, nothing observed) against
// budget_day_unknown_tokens 2,000,000, and a Designer session whose turn 1
// was admitted held: nothing of the turn allocated.
function heldFixture(t) {
  const s = scratch(t);
  const { db, at, run, receipt } = s;
  run('run_b1', 'builder', 'one_shot', 1);
  run('run_b2', 'builder', 'one_shot', 2);
  receipt('inv_b1', 'run_b1', null, { budget_run_billable_tokens: 1_500_000 });
  receipt('inv_b2', 'run_b2', null, { budget_run_billable_tokens: 1_500_000 });
  run('run_d', 'designer', 'session', 3, { turn_count: 1 });
  db.prepare(`INSERT INTO "session_held_turns" ("id", "created_at", "project", "run", "number", "limits", "waiting_on") VALUES ('sht_1', ?, ?, 'run_d', 1, ?, ?)`).run(
    at,
    P,
    JSON.stringify(['budget_day_unknown_tokens']),
    JSON.stringify([
      { run: 'run_b1', role: 'builder', invocation: 'inv_b1' },
      { run: 'run_b2', role: 'builder', invocation: 'inv_b2' },
    ]),
  );
  db.prepare(`INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "closing", "cleanup_authority") VALUES ('lease_d', ?, 'run', 'run_d', 'inc', 1, ?, ?, '2000-01-01T00:00:00.000Z', 0, 0)`).run(at, at, at);
  db.prepare(`INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold") VALUES ('wi_later', ?, ?, 1, 'fix', '{}', 'eligible', 'test', 't1', 1, 0, 0, 0, 0)`).run(at, P);
  return s;
}
const release = (db) => transact(db, ENGINE_ACTOR, (tx) => releaseHeldTurn(tx, { run: 'run_d', incarnation: 'inc_now', scope: null, scripted: '1' }));
const allocated = (db) => ({
  turns: db.prepare('SELECT COUNT(*) AS n FROM "turns" WHERE "run" = ?').get('run_d').n,
  receipts: db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts" WHERE "run" = ?').get('run_d').n,
  domains: db.prepare('SELECT COUNT(*) AS n FROM "execution_domains" WHERE "run" = ?').get('run_d').n,
  ownership: db.prepare('SELECT COUNT(*) AS n FROM "process_ownership" o JOIN "execution_domains" d ON d."id" = o."domain" WHERE d."run" = ?').get('run_d').n,
});

test('a held turn allocates nothing; it is shown held naming the limit and the runs that reserve the day; it is released, and allocated, once they end', (t) => {
  testMode(t);
  const { db, end } = heldFixture(t);
  assert.deepEqual(allocated(db), { turns: 0, receipts: 0, domains: 0, ownership: 0 }, 'no turn row, receipt, domain or process ownership while held');
  assert.deepEqual(heldTurnsNow(db, null).map((h) => [h.run, h.turn]), [['run_d', 1]], 'listed, so recovery keeps the session and the tick tries it');
  assert.equal(release(db).released, false, 'the day still passed: held');
  const view = sessionView(db, P, 'run_d');
  const turn = view.turns.find((x) => x.turn === 1);
  assert.equal(turn.state, 'held');
  assert.deepEqual(turn.held.limits, ['budget_day_unknown_tokens'], 'naming the limit');
  assert.deepEqual(turn.held.waiting_on.map((w) => w.run), ['run_b1', 'run_b2'], 'and the runs whose reservations pass it (N3)');
  assert.equal(view.run.held?.turn, 1);
  assert.deepEqual(expiredRunLeases(db, '2050-01-01T00:00:00.000Z').map((r) => r.run).filter((r) => r === 'run_d'), [], 'a held turn owns no process: its lease is not reconciled');
  end('inv_b1');
  const out = release(db);
  assert.equal(out.released, true, 'one Builder ended: 1,500,000 reserved, within the limit');
  assert.deepEqual(allocated(db), { turns: 1, receipts: 1, domains: 1, ownership: 1 }, 'released: the turn, its receipt, its domain and its ownership written now');
  assert.equal(heldTurnsNow(db, null).length, 0);
  assert.equal(sessionView(db, P, 'run_d').turns.find((x) => x.turn === 1).state, 'running');
  assert.ok(db.prepare('SELECT "expires_at" FROM "leases" WHERE "id" = ?').get('lease_d').expires_at > '2000-01-02', 'its lease taken from the release');
});

test('fairness: a one-shot waits behind a held Designer turn, its reason naming the limit and the runs in flight; after the release the day check alone decides', (t) => {
  testMode(t);
  const { db, end } = heldFixture(t);
  const item = db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get('wi_later');
  const reason = dispatchBlocker(db, item, { check: false }) ?? '';
  assert.match(reason, /turn 1 of Designer session run_d, held on budget_day_unknown_tokens while builder run run_b1, builder run run_b2 reserve the day/);
  end('inv_b1');
  end('inv_b2');
  assert.match(dispatchBlocker(db, item, { check: false }) ?? '', /held on/, 'the day admits the one-shot now, and still the held turn starts first');
  assert.equal(release(db).released, true);
  assert.equal(dispatchBlocker(db, item, { check: false }), 'budget exhausted', 'the turn in flight reserves the session\'s 3,000,000: the one-shot waits on the day limit itself');
});

test('a Designer turn in flight reserves what its session has left', (t) => {
  const { db, at, run, receipt } = scratch(t);
  run('run_d', 'designer', 'session', 1, { turn_count: 2 });
  db.prepare(`INSERT INTO "turns" ("id", "created_at", "project", "run", "number", "invocation", "domain", "started_at") VALUES ('turn_1', ?, ?, 'run_d', 1, 'inv_1', 'dom_1', ?), ('turn_2', ?, ?, 'run_d', 2, 'inv_2', 'dom_2', ?)`).run(at, P, at, at, P, at);
  const snap = { budget_run_billable_tokens: 1_500_000, designer_session_budget_billable_tokens: 3_000_000 };
  receipt('inv_1', 'run_d', 'turn_1', snap);
  receipt('inv_2', 'run_d', 'turn_2', snap);
  db.prepare(
    `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "raw_usage", "normalization_version", "billable_in", "out", "usage_complete", "cost_status", "day_utc")
     VALUES ('led_1', ?, ?, 'inv_1', 'run_d', 'turn_1', 'designer', 'scripted', 'opus', '{}', 'n', 2400000, 100000, 1, 'unknown', '1999-01-01')`,
  ).run(at, P);
  assert.deepEqual(exhaustedLimits(db, P, { check: false, dispatch: true }), [], 'turn 2 reserves 500,000: within the day limit');
});

// ---- S2: findings named and folded -------------------------------------------------------------------

test('a conflict without its subject is refused naming the field; role-chosen key names are capped', () => {
  const base = { status: 'completed', summary: 's', reply: 'r', artifact_changed: false };
  assert.match(sessionReplyProblem({ ...base, findings: [{ category: 'contract_conflict', severity: 'low', message: 'm' }] }, 'designer'), /findings\[0\]\.interface is required/);
  assert.match(sessionReplyProblem({ ...base, findings: [{ category: 'requirement_conflict', severity: 'low', message: 'm', interface: 'x' }] }, 'designer'), /findings\[0\]\.requirement is required/);
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}${'x'.repeat(60)}`, 1]));
  const text = sessionReplyProblem({ ...base, ...many }, 'designer');
  assert.match(text, /and 3 more/);
  assert.ok(!text.includes('x'.repeat(41)), 'each name cut to 40 characters');
});

test('the same conflict about the same subject, still open, is folded into the open finding: one row, one question', (t) => {
  const { db, run } = scratch(t);
  run('run_d', 'designer', 'session', 1, { turn_count: 1 });
  const f = { category: 'contract_conflict', severity: 'medium', message: 'no full error', interface: 'add-item' };
  const first = transact(db, ENGINE_ACTOR, (tx) => recordDesignFindings(tx, { project: P, run: 'run_d', turn: 1, findings: [f] }));
  const second = transact(db, ENGINE_ACTOR, (tx) => recordDesignFindings(tx, { project: P, run: 'run_d', turn: 2, findings: [{ ...f, message: 'said again' }] }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "design_findings"').get().n, 1, 'one finding');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "decisions" WHERE "subject_type" = 'design_finding'`).get().n, 1, 'one question');
  assert.match(first, /owner's to route/);
  assert.match(second, /already before the owner/);
  transact(db, ENGINE_ACTOR, (tx) => recordDesignFindings(tx, { project: P, run: 'run_d', turn: 3, findings: [{ ...f, interface: 'list-items' }] }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "design_findings"').get().n, 2, 'another subject is another finding');
});

// ---- N1: the specification's targets unknown -------------------------------------------------------

test('clause 5: targets unknown (an unreadable representation) are refused as unknown and not routed to a specification change', () => {
  const MODULES = { version: 1, modules: [{ name: 'web', surface: 'ui', paths: ['web/'], sensitive_areas: [], interfaces: [], targets: [{ target: 'web', ui_technology: 'html_css' }] }], mapping_from_spec: [] };
  const baseline = { spec_version: 1, requirements: [], questions: [], architecture_version: 1, roadmap_version: 1, head: 'h', project_tier: 'T1', completed_phases: [], approved: null, design: { policy: 'before_build', spec_targets: null, spec_targets_unknown: 'the representation of specification version 1 cannot be read' } };
  const artifacts = {
    modules: MODULES,
    roadmap: { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['web'], requirement_ids: [], depends_on: [] }] },
    adrs: {},
    adr_front_matter: {},
    architecture_text: null,
    plan: { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages: [], conformance: 'within_baseline' },
  };
  const r = checkPlan(baseline, artifacts);
  const reason = r.reasons.find((x) => x.code === 'SPEC_TARGETS_MISSING');
  assert.ok(reason && reason.subjects[0].startsWith('unknown: '), JSON.stringify(r.reasons));
  assert.equal(r.needs_spec_change, false);
  const missing = checkPlan({ ...baseline, design: { policy: 'before_build', spec_targets: null } }, artifacts);
  assert.deepEqual(missing.reasons.find((x) => x.code === 'SPEC_TARGETS_MISSING')?.subjects, ['web']);
  assert.equal(missing.needs_spec_change, true);
});

// ---- S3: the release hook's count over the selection --------------------------------------------------

const { designView } = await import(join(dist, 'design', 'view.js'));

test('assets_required counts the selected slots, a selected one with no effective row among them; a slot the selection leaves out is not counted', (t) => {
  const { db, at } = scratch(t);
  const slot = (key, kind, variants) => ({ key, kind, purpose: kind, platforms: ['web'], variants: variants.map((name) => ({ name, format: 'svg', file: `assets/${key}/${name}.svg`, digest: `d_${key}_${name}` })), slot_version: 1, status: 'placeholder', provenance: 'engine_placeholder' });
  const manifest = { version: 1, slots: [slot('logo', 'logo', ['full', 'compact']), slot('favicon', 'favicon', ['default']), slot('splash', 'splash', ['default'])] };
  db.prepare(`INSERT INTO "design_inventories" ("id", "created_at", "project", "inventory_digest", "revision", "inventory", "manifest", "recorded_at") VALUES ('dinv_1', ?, ?, 'dg', 'r1', ?, ?, ?)`).run(
    at,
    P,
    JSON.stringify({ inventory_digest: 'dg', targets: [], ui_requirements: [], interfaces: [], obligations: [], fixtures: [], cross_platform: false }),
    JSON.stringify(manifest),
    at,
  );
  // Before any approval: every default slot, none with an effective row yet.
  assert.deepEqual(designView(db, { project: P }).assets_required.not_approved, ['favicon', 'logo', 'splash']);
  // Approved with splash narrowed away; logo approved (both variants), favicon's row missing.
  db.prepare(
    `INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "revision", "blobs", "origin", "targets", "asset_manifest", "selection", "narrowings", "status", "findings")
     VALUES ('dsg_1', ?, ?, 1, 'full', 'r2', '{}', 'intended', '[]', ?, ?, '[]', 'approved', '[]')`,
  ).run(at, P, JSON.stringify(manifest), JSON.stringify({ themes: ['light'], slots: [{ kind: 'logo', variants: ['full', 'compact'] }, { kind: 'favicon', variants: ['default'] }], layouts: [] }));
  for (const v of ['full', 'compact']) {
    db.prepare(`INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms") VALUES (?, ?, ?, 'logo', 'logo', ?, 1, 'approved', 'd', 'svg', 'r2', 'f', '["web"]')`).run(`deff_${v}`, at, P, v);
  }
  const read = designView(db, { project: P });
  assert.deepEqual(read.assets_required.not_approved, ['favicon'], 'the selected favicon counts though it has no row; splash, narrowed away, does not');
  assert.equal(read.assets_required.count, 1);
  assert.equal(read.assets_required.for, 'live');
});

const { approveDesign } = await import(join(dist, 'design', 'approval.js'));

test('a slot narrowed away by an earlier design and selected again gets its engine placeholder back as its effective version at the approval', (t) => {
  const { db, at } = scratch(t);
  const slot = (key, kind) => ({ key, kind, purpose: kind, platforms: ['web'], variants: [{ name: 'default', format: 'svg', file: `assets/${key}/default.svg`, digest: `d_${key}` }], slot_version: 1, status: 'placeholder', provenance: 'engine_placeholder' });
  const manifest = { version: 1, slots: [slot('favicon', 'favicon'), slot('splash', 'splash')] };
  db.prepare(`INSERT INTO "design_inventories" ("id", "created_at", "project", "inventory_digest", "revision", "inventory", "manifest", "recorded_at") VALUES ('dinv_1', ?, ?, 'dg', 'r1', ?, ?, ?)`).run(
    at,
    P,
    JSON.stringify({ inventory_digest: 'dg', targets: [], ui_requirements: [], interfaces: [], obligations: [], fixtures: [], cross_platform: false }),
    JSON.stringify(manifest),
    at,
  );
  // splash was narrowed away by an earlier approval: only favicon has a row.
  db.prepare(`INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms") VALUES ('deff_f', ?, ?, 'favicon', 'favicon', 'default', 1, 'placeholder', 'd_favicon', 'svg', 'r1', 'f', '["web"]')`).run(at, P);
  db.prepare(
    `INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "revision", "blobs", "origin", "targets", "asset_manifest", "selection", "narrowings", "status", "findings")
     VALUES ('dsg_2', ?, ?, 2, 'full', 'r2', '{}', 'intended', '[]', ?, ?, '[]', 'proposed', '[]')`,
  ).run(at, P, JSON.stringify(manifest), JSON.stringify({ themes: ['light'], slots: [{ kind: 'favicon', variants: ['default'] }, { kind: 'splash', variants: ['default'] }], layouts: [] }));
  transact(db, ENGINE_ACTOR, (tx) => approveDesign(tx, { revision: 'dsg_2', specRevision: null, withoutCriteria: true }));
  const rows = db.prepare('SELECT "slot", "variant", "source", "digest", "since_design_revision" FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot"').all(P);
  assert.deepEqual(
    rows.map((r) => [r.slot, r.variant, r.source, r.digest]),
    [
      ['favicon', 'default', 'placeholder', 'd_favicon'],
      ['splash', 'default', 'placeholder', 'd_splash'],
    ],
  );
  assert.equal(rows.find((r) => r.slot === 'splash').since_design_revision, 'dsg_2');
});
