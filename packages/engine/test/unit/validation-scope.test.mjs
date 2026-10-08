// Developer tests for M3 slice 20, validation scope (D3 §§4.1 to 4.4; L3;
// B04; Q7, Q10; SEAM.md §§221 to 226): computeScope's required set, its
// coverage, kinds, floors and tier; presence and its basis; the candidate's
// content (registration and the content hash from one rule); checks_due's
// form; the cadence by the scope tier. Pure functions, and a scratch store
// with the engine's migrations.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { computeScope, cadenceTier, mayRaise, signoffsOf, missingSubjects, inModule, presentModules, KIND_INVENTORY, MODULE_PRESENCE } = await import(join(dist, 'checks', 'scope.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { candidateContent, contentHash, getCandidate, moduleBasis, presenceOf, recordPresence } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { dueOwed, registerForTrigger, registrationSet } = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { ensureModules } = await import(join(dist, 'store', 'transitions', 'baseline.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

// ---- computeScope -------------------------------------------------------------------------

const chk = (id, kind, extra = {}) => ({
  id,
  key: id,
  kind,
  origin: 'acceptance',
  required: true,
  gate_kinds: ['stage', 'alpha_authorize'],
  tier_floor: null,
  criteria: [],
  requirements: [],
  sensitive_areas: [],
  ...extra,
});
const req = (id, criteria, areas = []) => ({ id, key: id, criteria, sensitive_areas: areas });
const base = (over) => ({
  kind: 'stage',
  projectTier: 'T1',
  checks: [chk('acc', 'acceptance', { criteria: ['R1.1'], requirements: ['R1'] }), chk('smoke', 'smoke')],
  requirements: [req('R1', ['R1.1'])],
  delivered: ['R1'],
  partial: [],
  stageImplements: ['R1'],
  modules: [],
  ...over,
});

test('a complete T1 stage scope misses nothing; its required set is its acceptance and smoke checks', () => {
  const s = computeScope(base({}));
  assert.deepEqual(missingSubjects(s.missing), []);
  assert.deepEqual(s.required.map((c) => c.id).sort(), ['acc', 'smoke']);
  assert.equal(s.tier, 'T1');
});

test('an uncovered criterion by its key; a requirement with null or [] criteria is uncertain by its id', () => {
  assert.deepEqual(computeScope(base({ requirements: [req('R1', ['R1.1', 'R1.2'])] })).missing.criteria, ['R1.2']);
  assert.deepEqual(computeScope(base({ requirements: [req('R1', null)] })).missing.uncertain, ['R1']);
  assert.deepEqual(computeScope(base({ requirements: [req('R1', [])] })).missing.uncertain, ['R1']);
});

test('a developer check is in the set and covers nothing, criterion or kind', () => {
  const s = computeScope(base({ checks: [chk('dev', 'acceptance', { origin: 'developer', criteria: ['R1.1'] }), chk('smoke', 'smoke')] }));
  assert.ok(s.required.some((c) => c.id === 'dev'));
  assert.deepEqual(s.missing.criteria, ['R1.1']);
  assert.deepEqual(s.missing.kinds, ['kind:acceptance']);
});

test('the kind inventory per tier; a tier floor above the scope removes a check and its kind stays missing', () => {
  assert.deepEqual(KIND_INVENTORY.T3.length, 6);
  const s = computeScope(base({ projectTier: 'T2', checks: [...base({}).checks, chk('integ', 'integration', { tier_floor: 'T3' }), chk('lint', 'security_lint')] }));
  assert.deepEqual(s.missing.kinds, ['kind:integration']);
  assert.ok(!s.required.some((c) => c.id === 'integ'));
});

test('a floor applies only for a scope category, whatever its tier floor, and only when it lists the gate kind', () => {
  const floor = chk('f', 'sensitivity_floor', { sensitive_areas: ['personal_data'], tier_floor: 'T3' });
  const plain = computeScope(base({ checks: [...base({}).checks, floor] }));
  assert.ok(!plain.required.some((c) => c.id === 'f'), 'no category: the floor is not required');
  const sensitive = computeScope(base({ requirements: [req('R1', ['R1.1'], ['personal_data'])], checks: [...base({}).checks, floor] }));
  assert.ok(sensitive.required.some((c) => c.id === 'f'));
  assert.deepEqual(sensitive.missing.areas, []);
  const alphaOnly = computeScope(base({ requirements: [req('R1', ['R1.1'], ['personal_data'])], checks: [...base({}).checks, { ...floor, gate_kinds: ['alpha_authorize'] }] }));
  assert.deepEqual(alphaOnly.missing.areas, ['area:personal_data']);
});

test('partial delivery brings a requirement\'s areas into the stage scope (B04)', () => {
  const s = computeScope(base({ requirements: [req('R1', ['R1.1'], ['authentication'])], delivered: [], partial: ['R1'] }));
  assert.deepEqual(s.categories, ['authentication']);
  assert.deepEqual(s.obligations, []);
});

test('module overrides raise the tier, never lower it; T3 sign-offs per scope module by name', () => {
  assert.equal(cadenceTier('T1', [{ tier_override: 'T3' }]), 'T3');
  assert.equal(cadenceTier('T2', [{ tier_override: 'T1' }]), 'T2');
  assert.equal(mayRaise('T2', [{ tier_override: 'T2' }]), false);
  assert.equal(mayRaise('T1', [{ tier_override: 'T2' }]), true);
  const s = computeScope(base({ modules: [{ id: 'm1', name: 'billing', sensitive_areas: ['payments_financial_data'], tier_override: 'T3' }] }));
  assert.equal(s.tier, 'T3');
  assert.deepEqual(s.categories, ['payments_financial_data']);
  assert.deepEqual(signoffsOf('T3', [{ name: 'billing' }]).map((x) => x.module ?? x.scope), ['candidate', 'billing', 'security']);
});

test('an unread presence (modules null) is named module_presence, never taken as no module', () => {
  const s = computeScope(base({ kind: 'alpha_authorize', modules: null }));
  assert.deepEqual(s.missing.unread, [MODULE_PRESENCE]);
});

test('a module path is a file or a directory prefix, never a name prefix', () => {
  assert.ok(inModule('billing/pay.js', ['billing/']));
  assert.ok(inModule('billing/pay.js', ['billing']));
  assert.ok(!inModule('billingx/pay.js', ['billing']));
  assert.ok(inModule('README.md', ['README.md']));
  assert.deepEqual(presentModules(['src/a.js'], [{ id: 'a', paths: ['src/'] }, { id: 'b', paths: ['web/'] }]), ['a']);
});

// ---- the store: presence, content, registration, checks_due -------------------------------

const AT = '2026-10-08T00:00:00.000Z';
const A = 'a'.repeat(40);

function store(t, { modules = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    'f'.repeat(64),
    AT,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress)
     VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing')`,
    AT,
    A,
    AT,
  );
  for (const [id, kind, areas] of [
    ['chk_smoke', 'smoke', '[]'],
    ['chk_floor', 'sensitivity_floor', '["payments_financial_data"]'],
  ]) {
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, sensitive_areas)
       VALUES (?, ?, 'prj_1', ?, 'pv_1', ?, 1, '["stage","alpha_authorize"]', ?, 'h', 'direct', ?)`,
      id,
      AT,
      id,
      kind,
      `.surety/checks/defs/${id}.json`,
      areas,
    );
  }
  if (modules.length > 0) transact(db, ENGINE_ACTOR, (tx) => ensureModules(tx, { project: 'prj_1', modules }));
  return { db, run };
}

const cand = (db) => getCandidate(db, 'cand_1');
const billing = { name: 'billing', paths: ['billing/'], sensitive_areas: ['payments_financial_data'] };

test('with no module, presence is known empty and nothing is unread', (t) => {
  const { db } = store(t);
  assert.deepEqual(presenceOf(db, 'prj_1', cand(db)), []);
  assert.deepEqual(candidateContent(db, 'prj_1', cand(db), 'pv_1').unread, []);
});

test('presence is unread until recorded, and unread again once the module is redefined (its basis)', (t) => {
  const { db } = store(t, { modules: [billing] });
  assert.equal(presenceOf(db, 'prj_1', cand(db)), null);
  assert.deepEqual(candidateContent(db, 'prj_1', cand(db), 'pv_1').unread, [MODULE_PRESENCE]);
  assert.equal(registrationSet(db, 'prj_1', cand(db), 'pv_1').unread, true);
  const mod = db.prepare(`SELECT id FROM modules WHERE name = 'billing'`).get().id;
  const basis = moduleBasis(db, 'prj_1');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [mod], basis: 'other' })), false, 'a read under other definitions is not kept');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [mod], basis })), true);
  assert.deepEqual(presenceOf(db, 'prj_1', cand(db)), [mod]);
  const content = candidateContent(db, 'prj_1', cand(db), 'pv_1');
  assert.deepEqual(content.categories, ['payments_financial_data']);
  assert.ok(content.checks.some((c) => c.id === 'chk_floor'), 'the present module brings its floor into registration');
  transact(db, ENGINE_ACTOR, (tx) => ensureModules(tx, { project: 'prj_1', modules: [{ ...billing, paths: ['pay/'] }] }));
  assert.equal(presenceOf(db, 'prj_1', cand(db)), null, 'redefined: the recorded presence is unread, not empty');
});

test('the content hash changes with presence and names an unread fact, never hashing it as empty', (t) => {
  const { db } = store(t, { modules: [billing] });
  const unread = contentHash(db, 'prj_1', cand(db));
  const mod = db.prepare(`SELECT id FROM modules WHERE name = 'billing'`).get().id;
  transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [], basis: moduleBasis(db, 'prj_1') }));
  const absent = contentHash(db, 'prj_1', cand(db));
  assert.notEqual(unread, absent);
  db.prepare(`UPDATE candidates SET module_presence = NULL`).run();
  transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [mod], basis: moduleBasis(db, 'prj_1') }));
  assert.notEqual(contentHash(db, 'prj_1', cand(db)), absent);
});

test('a nomination owing its registration records checks_due as {trigger, at, owed}; the slice-15 list form still reads', (t) => {
  const { db } = store(t, { modules: [billing] });
  const trigger = { source: 'nomination', id: 'cand_1', generation: 1 };
  transact(db, ENGINE_ACTOR, (tx) => registerForTrigger(tx, { project: 'prj_1', candidate: 'cand_1', version: 'pv_1', trigger }));
  const due = JSON.parse(db.prepare(`SELECT checks_due FROM candidates WHERE id = 'cand_1'`).get().checks_due);
  assert.deepEqual(due.trigger, trigger);
  assert.equal(typeof due.at, 'string');
  assert.equal(due.owed.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_executions').get().n, 0);
  assert.deepEqual(dueOwed(JSON.stringify([{ trigger, at: AT }])).map((d) => d.trigger), [trigger]);
  assert.deepEqual(dueOwed(null), []);
});

test('cadence (Q10): an unread presence never lowers the tier; with no module able to raise it, nothing is read and nothing nominates', async (t) => {
  const { cadenceOf } = await import(join(dist, 'store', 'transitions', 'accept.js'));
  const raising = store(t, { modules: [{ ...billing, tier_override: 'T2' }] });
  const at = (db, presence) => transact(db, ENGINE_ACTOR, (tx) => cadenceOf(tx, { project: 'prj_1', tier: 'T1', kind: 'fix', stage: null, namesFinding: true, presence }));
  assert.deepEqual(at(raising.db, 'unread'), { cadence: true, unread: true });
  assert.deepEqual(at(raising.db, undefined), { cadence: true, unread: true });
  const mod = raising.db.prepare(`SELECT id FROM modules WHERE name = 'billing'`).get().id;
  const basis = moduleBasis(raising.db, 'prj_1');
  assert.deepEqual(at(raising.db, { modules: [mod], basis }), { cadence: true, unread: false });
  assert.deepEqual(at(raising.db, { modules: [], basis }), { cadence: false, unread: false });
  assert.deepEqual(at(raising.db, { modules: [mod], basis: 'stale' }), { cadence: true, unread: true }, 'a read under other definitions is unread');
  const plain = store(t, { modules: [billing] });
  assert.deepEqual(at(plain.db, 'unread'), { cadence: false, unread: false });
  assert.deepEqual(
    transact(plain.db, ENGINE_ACTOR, (tx) => cadenceOf(tx, { project: 'prj_1', tier: 'T1', kind: 'fix', stage: null, namesFinding: false, presence: 'unread' })),
    { cadence: false, unread: false },
    'a fix naming no finding is no cadence point at T1',
  );
});

// ---- the slice-20 review's fixes ----------------------------------------------------------

test('S1: a touched requirement no index row registered (criteria null) is uncertain, delivered or partial; one indexed with no criterion and only partial is not', () => {
  const partialNull = computeScope(base({ requirements: [req('R1', ['R1.1']), req('R2', null)], partial: ['R2'], stageImplements: ['R1', 'R2'] }));
  assert.deepEqual(partialNull.missing.uncertain, ['R2']);
  assert.ok(missingSubjects(partialNull.missing).includes('R2'));
  const alpha = computeScope(base({ kind: 'alpha_authorize', requirements: [req('R1', ['R1.1']), req('R2', null)], partial: ['R2'] }));
  assert.deepEqual(alpha.missing.uncertain, ['R2'], 'at a deployment gate too');
  const unknownRow = computeScope(base({ partial: ['R9'], stageImplements: ['R1', 'R9'] }));
  assert.deepEqual(unknownRow.missing.uncertain, ['R9'], 'a requirement with no row at all is not known either');
  const indexedEmpty = computeScope(base({ requirements: [req('R1', ['R1.1']), req('R2', [])], partial: ['R2'], stageImplements: ['R1', 'R2'] }));
  assert.deepEqual(indexedEmpty.missing.uncertain, [], 'indexed, its areas are known; not an obligation, nothing to cover');
  const notTouched = computeScope(base({ requirements: [req('R1', ['R1.1']), req('R2', null)], partial: ['R2'], stageImplements: ['R1'] }));
  assert.deepEqual(notTouched.missing.uncertain, [], "another stage's requirement is not this stage scope's");
  const deliveredNull = computeScope(base({ requirements: [req('R1', null)] }));
  assert.deepEqual(deliveredNull.missing.uncertain, ['R1'], 'named once');
});

test('minor 4: a developer-origin floor is in the set and supplies no area', () => {
  const s = computeScope(base({ requirements: [req('R1', ['R1.1'], ['personal_data'])], checks: [...base({}).checks, chk('f', 'sensitivity_floor', { origin: 'developer', sensitive_areas: ['personal_data'] })] }));
  assert.ok(s.required.some((c) => c.id === 'f'));
  assert.deepEqual(s.missing.areas, ['area:personal_data']);
});

test('minor 3: module paths the matcher cannot interpret are refused by modulePathOk and read as unread, never absent', async () => {
  const { modulePathOk } = await import(join(dist, 'checks', 'scope.js'));
  for (const ok of ['src/', 'src', 'src/auth/', 'README.md', '.surety/x/', 'a b/c']) assert.equal(modulePathOk(ok), true, ok);
  for (const bad of ['', '.', './src', 'src/**', 'src/*.js', '/abs', '..', 'a/../b', 'a//b', 'a/./b', 'a\\b', '//', '/']) assert.equal(modulePathOk(bad), false, JSON.stringify(bad));
  assert.equal(inModule('src/a.js', ['.']), false);
  assert.equal(presentModules(['src/a.js'], [{ id: 'a', paths: ['.'] }]), null, 'unread, not absent');
  assert.equal(presentModules(['src/a.js'], [{ id: 'a', paths: ['web/', 'src/**'] }]), null);
  assert.deepEqual(presentModules(['src/a.js'], [{ id: 'a', paths: ['src/', 'src/**'] }]), ['a'], 'present through an interpretable path');
  assert.deepEqual(presentModules(['src/a.js'], [{ id: 'a', paths: [] }]), [], 'no path: absent, known');
});

test('minor 3: the plan fixture refuses an uninterpretable module path with 400 modules[i].paths', async () => {
  const { parsePlanBody } = await import(join(dist, 'testing', 'fixtures.js'));
  const body = (paths) => ({ project: 'p', stages: [{ number: 1, goal: 'g' }], modules: [{ name: 'ok', paths: ['src/'] }, { name: 'm', paths }] });
  assert.doesNotThrow(() => parsePlanBody(body(['billing/'])));
  for (const bad of ['.', './src', 'src/**', '/abs/x', '../x', 'a/../b']) {
    assert.throws(
      () => parsePlanBody(body([bad])),
      (e) => e.status === 400 && e.code === 'invalid_value' && e.subject?.field === 'modules[1].paths',
      bad,
    );
  }
});

test('S2: the content hash covers the scope modules (id, paths, effective tier) and the required sign-offs', (t) => {
  const { db } = store(t, { modules: [billing] });
  const mod = () => db.prepare(`SELECT id FROM modules WHERE name = 'billing'`).get().id;
  const read = (modules) => transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules, basis: moduleBasis(db, 'prj_1') }));
  read([mod()]);
  const first = contentHash(db, 'prj_1', cand(db));
  const content = candidateContent(db, 'prj_1', cand(db), 'pv_1');
  assert.deepEqual(content.modules, [[mod(), ['billing/'], 'T1']]);
  // Redefine the paths; the presence is read again and the module is still
  // present with the same required set and categories.
  transact(db, ENGINE_ACTOR, (tx) => ensureModules(tx, { project: 'prj_1', modules: [{ ...billing, paths: ['billing/', 'pay/'] }] }));
  read([mod()]);
  const redefined = candidateContent(db, 'prj_1', cand(db), 'pv_1');
  assert.deepEqual(redefined.checks.map((c) => c.id), content.checks.map((c) => c.id));
  assert.deepEqual(redefined.categories, content.categories);
  assert.notEqual(contentHash(db, 'prj_1', cand(db)), first, 'redefined paths: changed content');
  const second = contentHash(db, 'prj_1', cand(db));
  // Raise its tier: T2 adds the candidate sign-off, the required set as it was.
  transact(db, ENGINE_ACTOR, (tx) => ensureModules(tx, { project: 'prj_1', modules: [{ ...billing, paths: ['billing/', 'pay/'], tier_override: 'T2' }] }));
  const raised = candidateContent(db, 'prj_1', cand(db), 'pv_1');
  assert.deepEqual(raised.checks.map((c) => c.id), content.checks.map((c) => c.id));
  assert.deepEqual(raised.signoffs, [{ role: 'reviewer', scope: 'candidate' }]);
  assert.equal(raised.tier, 'T2');
  assert.notEqual(contentHash(db, 'prj_1', cand(db)), second, 'a raised tier: changed content');
  // T2 to T3 changes the sign-offs (module and security) and the effective tier.
  const t2 = contentHash(db, 'prj_1', cand(db));
  transact(db, ENGINE_ACTOR, (tx) => ensureModules(tx, { project: 'prj_1', modules: [{ ...billing, paths: ['billing/', 'pay/'], tier_override: 'T3' }] }));
  assert.notEqual(contentHash(db, 'prj_1', cand(db)), t2);
  assert.equal(contentHash(db, 'prj_1', cand(db)), contentHash(db, 'prj_1', cand(db)), 'deterministic');
});

test('S2: a project with no module and no sign-off keeps the hash form it had (no modules or signoffs member)', (t) => {
  const { db } = store(t);
  const content = candidateContent(db, 'prj_1', cand(db), 'pv_1');
  assert.deepEqual(content.modules, []);
  assert.deepEqual(content.signoffs, []);
  assert.equal(content.tier, 'T1');
});

test('minor 6: the candidate tier is the highest of its scopes; a module present only at Alpha raises it', (t) => {
  const { db } = store(t, { modules: [{ ...billing, tier_override: 'T2' }] });
  assert.equal(candidateContent(db, 'prj_1', cand(db), 'pv_1').tier, 'T2', 'unread presence: every module, never lower');
  transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [], basis: moduleBasis(db, 'prj_1') }));
  assert.equal(candidateContent(db, 'prj_1', cand(db), 'pv_1').tier, 'T1');
  db.prepare('UPDATE candidates SET module_presence = NULL').run();
  const mod = db.prepare(`SELECT id FROM modules WHERE name = 'billing'`).get().id;
  transact(db, ENGINE_ACTOR, (tx) => recordPresence(tx, { candidate: 'cand_1', modules: [mod], basis: moduleBasis(db, 'prj_1') }));
  assert.equal(candidateContent(db, 'prj_1', cand(db), 'pv_1').tier, 'T2');
});

test('minor 7: a checks_due in a form this engine did not write is unknown: everything owed, never cleared or rewritten', async (t) => {
  const { readDue, registerDue } = await import(join(dist, 'store', 'transitions', 'checks.js'));
  const trigger = { source: 'nomination', id: 'cand_1', generation: 1 };
  for (const text of ['{}', '[]', '{"owed":[]}', '{"trigger":"x","at":1}', '"due"', 'null', 'not json', '[{"at":"x"}]', '{"owed":[{"trigger":{"source":"s"},"at":"x"}]}']) {
    const d = readDue(text);
    assert.equal(d.unknown, true, text);
    assert.deepEqual(dueOwed(text), [], text);
  }
  assert.equal(readDue(null), null);
  assert.equal(readDue(JSON.stringify({ trigger, at: AT })).unknown, false);
  assert.equal(readDue(JSON.stringify({ trigger, at: AT, owed: [{ trigger, at: AT, version: 'pv_1' }] })).owed[0].version, 'pv_1');
  // In a store with no module (nothing unread): registerDue would register
  // and clear a known mark; an unknown one stays as it was.
  const { db } = store(t);
  db.prepare(`UPDATE candidates SET checks_due = '{"weird":true}'`).run();
  transact(db, ENGINE_ACTOR, (tx) => registerDue(tx, { project: 'prj_1' }));
  assert.equal(db.prepare(`SELECT checks_due FROM candidates`).get().checks_due, '{"weird":true}');
  db.prepare(`UPDATE candidates SET checks_due = ?`).run(JSON.stringify({ trigger, at: AT }));
  transact(db, ENGINE_ACTOR, (tx) => registerDue(tx, { project: 'prj_1' }));
  assert.equal(db.prepare(`SELECT checks_due FROM candidates`).get().checks_due, null, 'a known mark is cleared once registered');
  // While a fact is unread, a trigger does not rewrite an unknown mark.
  const unread = store(t, { modules: [billing] });
  unread.db.prepare(`UPDATE candidates SET checks_due = '{"weird":true}'`).run();
  transact(unread.db, ENGINE_ACTOR, (tx) => registerForTrigger(tx, { project: 'prj_1', candidate: 'cand_1', version: 'pv_1', trigger }));
  assert.equal(unread.db.prepare(`SELECT checks_due FROM candidates`).get().checks_due, '{"weird":true}');
});
