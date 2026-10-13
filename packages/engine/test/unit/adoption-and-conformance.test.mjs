// Developer tests for M5 slice 32's pure and store-read parts (D6 §8; K10,
// K11; B11, B13): the adoption's signals and the idea's first version, the
// adopted tests' import specifiers, the source projection's comparison, and
// the Alpha barrier's guard that only a candidate whose application source
// is A opens it (M453 (e): no production path makes such a candidate before
// the barrier opens, so the guard is held here; SEAM.md §385).

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { ciEnvironments, firstVersionItems, isDeployFile, isTestFile } = await import(join(dist, 'adopt', 'adopt.js'));
const { specifiersOf, adoptedTestsValid } = await import(join(dist, 'adopt', 'boundary.js'));
const { projectionDigestOf } = await import(join(dist, 'adopt', 'projection.js'));
const { alphaBarrier, inConformancePhase, sourceMoved } = await import(join(dist, 'adopt', 'conformance.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { architectFindings } = await import(join(dist, 'plan', 'findings.js'));

const A = 'a'.repeat(40);
const DIGEST_A = 'd'.repeat(64);

// The rows the barrier and the projection read, and nothing else.
function store() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, adoption TEXT);
    CREATE TABLE candidates (id TEXT PRIMARY KEY, project TEXT, seq INTEGER, source_digest TEXT, progress TEXT);
    CREATE TABLE gate_evaluations (id TEXT PRIMARY KEY, candidate TEXT, gate_kind TEXT, outcome TEXT, stale INTEGER, created_at TEXT);
    CREATE TABLE phase_plans (id TEXT PRIMARY KEY, project TEXT, phase_number INTEGER, completed_at TEXT, created_at TEXT);
    CREATE TABLE stages (id TEXT PRIMARY KEY, project TEXT, phase_plan TEXT, created_at TEXT, status TEXT, implements TEXT, source_revision TEXT, conformance_source_digest TEXT, conformance_state TEXT, cancelled_at TEXT, conformance INTEGER);
  `);
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('p', JSON.stringify({ pinned_revision: A, source_digest: DIGEST_A, mode: 'full' }));
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('plain', null);
  return db;
}
const candidate = (db, id, seq, digest, progress) => db.prepare('INSERT INTO candidates VALUES (?, ?, ?, ?, ?)').run(id, 'p', seq, digest, progress);
const completion = (db, id, candidateId, outcome, stale = 0, at = '2026-10-12T00:00:00.000Z') => db.prepare('INSERT INTO gate_evaluations VALUES (?, ?, ?, ?, ?, ?)').run(id, candidateId, 'alpha_complete', outcome, stale, at);

test('M453 (e): a deployed candidate whose application source is not A does not open the barrier', () => {
  const db = store();
  candidate(db, 'c2', 2, 'e'.repeat(64), 'alpha_deployed');
  completion(db, 'g1', 'c2', 'satisfied');
  const b = alphaBarrier(db, 'p');
  assert.equal(b.open, false);
  assert.match(b.reason, /CONFORMANCE_ALPHA_PENDING/);
});

test('M453 (e): a candidate whose projection was never read (unknown) does not open it', () => {
  const db = store();
  candidate(db, 'c1', 1, null, 'alpha_deployed');
  completion(db, 'g1', 'c1', 'satisfied');
  assert.equal(alphaBarrier(db, 'p').open, false);
});

test('the barrier stays closed for a failed, a stale or a missing alpha_complete, and for a candidate not deployed', () => {
  const db = store();
  candidate(db, 'c1', 1, DIGEST_A, 'developing');
  completion(db, 'g1', 'c1', 'satisfied');
  assert.equal(alphaBarrier(db, 'p').open, false, 'not alpha_deployed');
  db.prepare("UPDATE candidates SET progress = 'alpha_deployed'").run();
  db.prepare("UPDATE gate_evaluations SET outcome = 'not_satisfied'").run();
  assert.equal(alphaBarrier(db, 'p').open, false, 'not satisfied');
  db.prepare("UPDATE gate_evaluations SET outcome = 'satisfied', stale = 1").run();
  assert.equal(alphaBarrier(db, 'p').open, false, 'stale');
  db.prepare('DELETE FROM gate_evaluations').run();
  assert.equal(alphaBarrier(db, 'p').open, false, 'none');
});

test('the barrier opens for A\'s candidate, deployed and verified; a project that is not adopted has none', () => {
  const db = store();
  candidate(db, 'c1', 1, DIGEST_A, 'alpha_deployed');
  completion(db, 'g1', 'c1', 'satisfied');
  assert.deepEqual([alphaBarrier(db, 'p').open, alphaBarrier(db, 'p').candidate], [true, 'c1']);
  assert.equal(alphaBarrier(db, 'plain').adopted, false);
});

test('CONFORMANCE_SOURCE_MOVED: equal digests pass; a moved candidate, head or binding, and every unread digest, are moved', () => {
  const db = store();
  db.prepare('INSERT INTO stages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'p', 'plan', '2026-10-12T00:00:00.000Z', 'integrated', '[]', A, DIGEST_A, 'nominated', null, 1);
  const facts = { candidate_revision: 'c'.repeat(40), candidate_digest: DIGEST_A, head: 'h'.repeat(40), head_digest: DIGEST_A, source_digests: { s: DIGEST_A } };
  assert.deepEqual(sourceMoved(db, { project: 'p', stage: 's', facts }), []);
  assert.ok(sourceMoved(db, { project: 'p', stage: 's', facts: { ...facts, candidate_digest: 'x'.repeat(64) } }).some((m) => m.startsWith('candidate:')));
  assert.ok(sourceMoved(db, { project: 'p', stage: 's', facts: { ...facts, head_digest: 'x'.repeat(64) } }).some((m) => m.startsWith('integration_head:')));
  assert.ok(sourceMoved(db, { project: 'p', stage: 's', facts: { ...facts, head_digest: null } }).includes('unread:integration_head'));
  assert.ok(sourceMoved(db, { project: 'p', stage: 's', facts: undefined }).includes('unread:projection'));
  db.prepare('UPDATE stages SET source_revision = ?').run('b'.repeat(40));
  assert.ok(sourceMoved(db, { project: 'p', stage: 's', facts }).some((m) => m.startsWith('source_revision:')));
});

test('the projection digest depends on every entry and not on their order', () => {
  const e = ['100644 blob 1111111111111111111111111111111111111111\tserver.mjs', '100644 blob 2222222222222222222222222222222222222222\tsrc/sum.mjs'];
  assert.equal(projectionDigestOf([...e].sort()), projectionDigestOf([...e].reverse().sort()));
  assert.notEqual(projectionDigestOf(e), projectionDigestOf([e[0].replace('100644', '100755'), e[1]]));
});

test('the signals name test, CI and deployment files by convention; the CI file\'s environments; the idea\'s first version', () => {
  assert.deepEqual(['test/a.mjs', 'x/tests/b.js', 'a_test.go', 'b.test.mjs', 'c.spec.ts', 'src/sum.mjs'].filter(isTestFile), ['test/a.mjs', 'x/tests/b.js', 'a_test.go', 'b.test.mjs', 'c.spec.ts']);
  assert.deepEqual(['Procfile', '.env.example', 'Dockerfile', 'docker-compose.yml', 'README.md'].filter(isDeployFile), ['Procfile', '.env.example', 'Dockerfile', 'docker-compose.yml']);
  assert.deepEqual(ciEnvironments('jobs:\n  t:\n    environment: production\n  u:\n    environment:\n      name: staging\n'), ['production', 'staging']);
  assert.deepEqual(firstVersionItems('# Idea\n\n## First version\n\n- Every answer is JSON.\n- Health.\n\n## Later\n\n- Not this.\n'), ['Every answer is JSON.', 'Health.']);
  assert.deepEqual(firstVersionItems(undefined), []);
});

test('the import specifiers an adopted copy is checked for, and the adopted_tests form', () => {
  assert.deepEqual(specifiersOf("import { a } from './helpers/expect.mjs';\nimport '../x.mjs';\nconst m = await import('../../src/sum.mjs');\nexport { b } from './b.mjs';\nconst r = require('./r.cjs');").sort(), ['../../src/sum.mjs', '../x.mjs', './b.mjs', './helpers/expect.mjs', './r.cjs']);
  assert.equal(adoptedTestsValid([{ from: ['t.mjs'], to: '.surety/checks/t.mjs', criteria: ['R1.1'], dependency_boundary: [{ path: 'src/a.mjs', disposition: 'application' }] }]), true);
  assert.equal(adoptedTestsValid([{ from: ['t.mjs'], to: 'x', criteria: [], dependency_boundary: [{ path: 'a', disposition: 'borrowed' }] }]), false);
});

test('S2: the conformance phase lasts until phase 1 is complete and the Alpha barrier has opened, not until the stage conforms', () => {
  const db = store();
  assert.equal(inConformancePhase(db, 'p'), true, 'no phase complete');
  db.prepare('INSERT INTO phase_plans VALUES (?, ?, ?, ?, ?)').run('plan1', 'p', 1, '2026-10-13T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
  assert.equal(inConformancePhase(db, 'p'), true, 'phase 1 complete, the barrier closed');
  candidate(db, 'c1', 1, DIGEST_A, 'alpha_deployed');
  completion(db, 'g1', 'c1', 'satisfied');
  assert.equal(inConformancePhase(db, 'p'), false, 'the barrier open');
  assert.equal(inConformancePhase(db, 'plain'), false, 'a project that is not adopted');
});

const MODULES = (requirements) => ({
  version: 1,
  modules: [
    { name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [], ...(requirements ? { requirements: requirements.lib } : {}) },
    { name: 'service', paths: ['server.mjs'], sensitive_areas: [], interfaces: [], ...(requirements ? { requirements: requirements.service } : {}) },
  ],
  mapping_from_spec: [],
});

test('the module map: a stage touching a module that holds a descriptive requirement is PLAN_DESCRIPTIVE_MODULE_TOUCHED, whatever it implements', () => {
  const requirements = [
    { key: 'R1', criteria: [], sensitive_areas: [], withdrawn: false, blocked_by_questions: [], descriptive_unverified: true },
    { key: 'R4', criteria: ['R4.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
  ];
  const baseline = { spec_version: 1, requirements, architecture_version: 1, roadmap_version: 1, head: 'a'.repeat(40), project_tier: 'T1', completed_phases: [1], approved: null, adopted: true };
  const plan = (modules) => ({ phase: 2, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) }, stages: [{ number: 1, goal: 'g', tasks: ['t'], modules, implements: ['R4'], adrs: [], depends_on: [], validation: { criteria: ['R4.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] }], conformance: 'within_baseline' });
  const roadmap = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'c', modules: ['lib', 'service'], requirement_ids: [], depends_on: [] }, { number: 2, goal: 'x', modules: ['lib', 'service'], requirement_ids: ['R1', 'R4'], depends_on: [1] }] };
  const touched = (m, p) => checkPlan(baseline, { modules: m, roadmap, adrs: {}, adr_front_matter: {}, architecture_text: null, plan: p }).reasons.find((r) => r.code === 'PLAN_DESCRIPTIVE_MODULE_TOUCHED');
  assert.deepEqual(touched(MODULES({ lib: ['R1'], service: ['R4'] }), plan(['lib', 'service']))?.subjects, ['stage 1:lib:R1']);
  assert.equal(touched(MODULES({ lib: ['R1'], service: ['R4'] }), plan(['service'])), undefined);
});

test('the module map: an unknown requirement, and a descriptive one no module holds, are findings naming them', () => {
  const files = (m) => ({ files: { '.surety/architecture/modules.json': JSON.stringify(m) } });
  const base = { requirement_keys: ['R1', 'R4'], spec_modules: [], descriptive_keys: ['R1'] };
  const codes = (m) => architectFindings(files(m), base).findings.map((f) => [f.code, f.subject.key]);
  assert.deepEqual(codes(MODULES({ lib: ['R1', 'R9'], service: ['R4'] })), [['module_requirement_unknown', 'R9']]);
  assert.deepEqual(codes(MODULES({ lib: [], service: ['R4'] })), [['module_requirement_unmapped', 'R1']]);
  assert.deepEqual(codes(MODULES(null)), [['module_requirement_unmapped', 'R1']]);
  assert.deepEqual(architectFindings(files(MODULES(null)), { ...base, descriptive_keys: [] }).findings, []);
});
