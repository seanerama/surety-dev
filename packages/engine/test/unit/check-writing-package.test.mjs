// Developer tests for what the Verifier of `check_correction` work is told
// (BS3 §3; D3 §§1.1 to 1.4, 4.3, Appendix B; SEAM.md §237): the roots, the
// definitions directory, every requirement with its criteria and approved
// text, the programs by name, a definition's members from the parser's own
// reference, the kinds the tiers require, the gate kinds the engine
// evaluates, and an example the parser accepts; never a program's path, the
// toolchain's paths or the governed env's values. Against a scratch store
// with the engine's migrations and a scratch package directory.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { contextFacts } = await import(join(dist, 'store', 'reads.js'));
const { writeContextPackage } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { DEFINITION_REFERENCE, defaultGoverned, parseDefinition, parseGoverned } = await import(join(dist, 'checks', 'schema.js'));
const { exampleDefinition, checkWritingText } = await import(join(dist, 'checks', 'guide.js'));

const AT = '2026-10-08T00:00:00.000Z';
const HOST_NODE = '/opt/hostnode/bin/node';
const ENV_VALUE = 'a-governed-env-value-7f3a';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const GOVERNED = {
  protected_paths: ['.surety/checks/'],
  check_commands: { node: { path: HOST_NODE } },
  runner_config: { direct: { read_paths: ['/opt/hostnode'], path: ['/opt/hostnode/bin', '/usr/bin', '/bin'], env: { TOOL_MODE: ENV_VALUE }, timeout_max_s: 300 } },
};

function store(t, { governed = parseGoverned(JSON.stringify(GOVERNED)).governed, version = true } = {}) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  const req = (id, key, text, criteria, areas = []) =>
    run(
      `INSERT INTO requirements (id, created_at, project, key, text_ref, assigned_phase, status, text, criteria, sensitive_areas) VALUES (?, ?, 'prj_1', ?, ?, 1, 'approved', ?, ?, ?)`,
      id,
      AT,
      key,
      `spec#${key}`,
      text,
      criteria === null ? null : JSON.stringify(criteria),
      JSON.stringify(areas),
    );
  req('req_10', 'R10', 'The tenth requirement.', ['R10.1']);
  req('req_1', 'R1', 'greeting(name) returns "Hello, " + name + "!".\nA second line of the text.', ['R1.1', 'R1.2']);
  req('req_2', 'R2', 'A session older than 30 minutes is rejected.', ['R2.1'], ['authentication']);
  req('req_3', 'R3', 'Not yet indexed.', null);
  run(`INSERT INTO modules (id, created_at, project, name, paths, sensitive_areas, tier_override) VALUES ('mod_1', ?, 'prj_1', 'payments', '["src/pay/"]', '["payments_financial_data"]', 'T2')`, AT);
  if (version) {
    run(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, check_ids, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, governed)
       VALUES ('pv_1', ?, 'prj_1', 1, 'f', '[]', 'initial', 'sean', 'human', ?, 1, ?, '[".surety/checks/"]', ?)`,
      AT,
      AT,
      AT,
      governed === null ? null : JSON.stringify(governed),
    );
  }
  run(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", criterion, proposed_severity, effective_severity, status)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_1', 'cand_1', 'run_v', 'verifier', 'defect', 'the session lives a thousand times too long', NULL, 'R2.1', 'high', 'high', 'dispositioned')`,
    AT,
  );
  const item = (id, seq, kind, subject) =>
    run(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, ?, ?, 'executing', 'test', ?, 1, 0, 0, 0, 0)`,
      id,
      AT,
      seq,
      kind,
      JSON.stringify(subject),
      id,
    );
  item('wi_cc', 1, 'check_correction', {});
  item('wi_routed', 2, 'check_correction', { finding: 'fnd_1' });
  item('wi_ver', 3, 'verification', {});
  const runRow = (id, seq, workItem) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, content_hash)
       VALUES (?, ?, 'prj_1', ?, ?, 'verifier', 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0, NULL)`,
      id,
      AT,
      seq,
      workItem,
      'a'.repeat(40),
      AT,
    );
  runRow('run_cc', 1, 'wi_cc');
  runRow('run_routed', 2, 'wi_routed');
  runRow('run_ver', 3, 'wi_ver');
  return db;
}

function packageOf(t, db, run) {
  const facts = contextFacts(db, { run });
  const dir = join(scratch(t), 'context');
  const claim = { run: facts.run.id, role: facts.run.role, work_item: facts.work_item.id, work_kind: facts.work_item.kind, base_revision: facts.run.base_revision, attempt: null };
  writeContextPackage(dir, claim, facts, { probe: false });
  const read = (p) => readFileSync(join(dir, p), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  const told = manifest.files.filter((f) => f.kind !== 'result_schema').map((f) => read(f.path)).join('\n');
  return { facts, manifest, read, prompt: read('prompt.md'), told, dir };
}

// The JSON block of the prompt's example.
const exampleIn = (prompt) => {
  const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
  return m ? JSON.parse(m[1]) : null;
};

test("the reference names exactly the members parseDefinition accepts: D3 A.4's sixteen, no more", () => {
  assert.deepEqual(Object.keys(DEFINITION_REFERENCE), ['schema', 'key', 'kind', 'origin', 'command', 'cwd', 'env', 'timeout_s', 'covers', 'gate_kinds', 'tier_floor', 'phase', 'runner_class', 'requires', 'inputs', 'egress']);
  const governed = parseGoverned(JSON.stringify(GOVERNED)).governed;
  const entries = [{ path: '.surety/checks/run/x.mjs', type: 'blob', mode: '100644', oid: '0'.repeat(40) }];
  const valid = { schema: 1, key: 'x', kind: 'acceptance', origin: 'acceptance', command: ['node', '.surety/checks/run/x.mjs'], cwd: '.', env: {}, timeout_s: 10, covers: { criteria: ['R1.1'] }, gate_kinds: ['stage'], tier_floor: 'T1', phase: 1, runner_class: 'direct', requires: [], inputs: ['.surety/checks/run/x.mjs'], egress: [] };
  assert.deepEqual(Object.keys(valid), Object.keys(DEFINITION_REFERENCE), 'the case uses every member');
  const ok = parseDefinition('.surety/checks/defs/x.json', 'x', JSON.stringify(valid), governed, entries);
  assert.deepEqual(ok.errors, [], 'every member of the reference is accepted');
  const extra = parseDefinition('.surety/checks/defs/x.json', 'x', JSON.stringify({ ...valid, artifacts: [] }), governed, entries);
  assert.deepEqual(extra.errors, [{ path: '.surety/checks/defs/x.json#/artifacts', code: 'unknown_field' }], 'a member outside it is not');
});

test('the example parses under the project governed values, and under another layout; none is made without a program or governed values', () => {
  const requirements = [{ key: 'R2', text: 't', text_ref: 'r', criteria: ['R2.1'], sensitive_areas: [] }];
  const governed = parseGoverned(JSON.stringify(GOVERNED)).governed;
  const ex = exampleDefinition({ governed, tier: 'T1', modules: [], requirements });
  assert.equal(ex.file, '.surety/checks/defs/r2-1.json');
  assert.deepEqual(ex.definition.covers, { criteria: ['R2.1'] });
  assert.deepEqual(ex.definition.gate_kinds, ['stage', 'alpha_authorize']);
  assert.equal(ex.definition.timeout_s, 120);
  const other = parseGoverned(JSON.stringify({ ...GOVERNED, protected_paths: ['qa/', 'more/'], check_discovery: { definitions: 'qa/defs/' }, check_commands: { python3: { path: '/usr/bin/python3' } }, runner_config: { direct: { timeout_max_s: 30 } } })).governed;
  const ex2 = exampleDefinition({ governed: other, tier: 'T1', modules: [], requirements: [] });
  assert.equal(ex2.file, 'qa/defs/smoke.json');
  assert.deepEqual(ex2.definition.command, ['python3', 'qa/run/smoke']);
  assert.equal(ex2.definition.kind, 'smoke');
  assert.equal(ex2.definition.timeout_s, 30);
  for (const e of [ex, ex2]) {
    const g = e === ex ? governed : other;
    const parsed = parseDefinition(e.file, e.definition.key, JSON.stringify(e.definition), g, [{ path: e.program, type: 'blob', mode: '100644', oid: '0'.repeat(40) }]);
    assert.deepEqual(parsed.errors, []);
  }
  assert.equal(exampleDefinition({ governed: defaultGoverned(), tier: 'T1', modules: [], requirements }), null, 'no program: no example');
  assert.equal(exampleDefinition({ governed: null, tier: 'T1', modules: [], requirements }), null);
});

test("a check_correction Verifier's package: the roots, the definitions directory, every requirement with its criteria and text, the program by name, the members, the kinds, the areas, the gate kinds, an example that parses", (t) => {
  const db = store(t);
  const { prompt, told, manifest, read } = packageOf(t, db, 'run_cc');
  assert.ok(prompt.includes('Work item: wi_cc (check_correction); run run_cc;'), 'the work item line, as the rehearsal reads it');
  assert.ok(!prompt.includes('Verify the work below'), 'not the generic Verifier task');
  for (const s of ['.surety/checks/', '.surety/checks/defs/', '.surety/checks/protected-policy.json', '`node`', 'at most 300 seconds', 'no network']) assert.ok(prompt.includes(s), s);
  for (const c of ['R1.1', 'R1.2', 'R2.1', 'R10.1']) assert.ok(prompt.includes(c), c);
  assert.ok(prompt.indexOf('- R2:') < prompt.indexOf('- R10:'), 'requirements in index order');
  assert.ok(prompt.includes('  > A second line of the text.'), 'each line of the approved text, quoted');
  assert.match(prompt, /- R3: not in the requirement index/);
  for (const r of ['R1', 'R2', 'R3', 'R10']) assert.ok(manifest.files.some((f) => f.path === `requirements/${r}.md` && f.kind === 'requirement'), `requirements/${r}.md`);
  assert.ok(read('requirements/R2.md').includes('A session older than 30 minutes is rejected.'));
  for (const m of Object.keys(DEFINITION_REFERENCE)) assert.ok(prompt.includes(`\`"${m}"\``), `the member "${m}"`);
  assert.ok(prompt.includes('"criteria"'));
  assert.match(prompt, /tier is T1: every scope requires .*`acceptance`, `smoke`\./);
  assert.match(prompt, /module `payments` raises a scope that includes it to T2, .*`integration`, `security_lint`/);
  assert.match(prompt, /sensitivity_floor.*`authentication`, `payments_financial_data`/);
  assert.match(prompt, /the engine evaluates `stage`, `alpha_authorize`/);
  assert.match(prompt, /no checks in its effective protected version/);
  assert.match(prompt, /`proposal`/);
  const ex = exampleIn(prompt);
  assert.equal(ex.key, 'r1-1');
  const governed = parseGoverned(JSON.stringify(GOVERNED)).governed;
  assert.deepEqual(parseDefinition('.surety/checks/defs/r1-1.json', 'r1-1', JSON.stringify(ex), governed, [{ path: ex.inputs[0], type: 'blob', mode: '100644', oid: '0'.repeat(40) }]).errors, []);
  for (const secret of [HOST_NODE, '/opt/hostnode', ENV_VALUE]) assert.ok(!told.includes(secret), `no ${secret} in the package`);
  assert.equal(manifest.files.some((f) => f.path === 'finding.json'), false, 'no finding when none was routed');
});

test("a routed check_correction: the finding is one no check verifies, never a fix of the code; the fix Builder's text is not given", (t) => {
  const db = store(t);
  const { prompt, read, manifest } = packageOf(t, db, 'run_routed');
  assert.ok(prompt.includes('Work item: wi_routed (check_correction);'));
  assert.ok(prompt.includes('## The finding this work was registered for'));
  assert.ok(prompt.includes('the session lives a thousand times too long'));
  assert.ok(prompt.includes('the criterion R2.1'));
  assert.ok(!prompt.includes('Fix the finding below'), 'not a fix task');
  assert.ok(!prompt.includes('fixing the code'), "not the fix Builder's instruction");
  assert.ok(!prompt.includes('## The finding you fix'));
  assert.equal(manifest.files.filter((f) => f.path === 'finding.json').length, 1);
  assert.equal(JSON.parse(read('finding.json')).id, 'fnd_1');
});

test('unknown governed values are said to be unknown, never taken as the defaults', (t) => {
  for (const opts of [{ version: false }, { governed: null }]) {
    const db = store(t, opts);
    const { prompt } = packageOf(t, db, 'run_cc');
    assert.match(prompt, /could not be read/);
    assert.ok(!prompt.includes('.surety/checks/defs/'), 'no default definitions directory stated as fact');
    assert.ok(!prompt.includes('```json'), 'no example');
  }
});

test('no program in the governed file: the Verifier is told no definition can be valid, with no example', () => {
  const lines = checkWritingText({ governed: defaultGoverned(), tier: 'T1', modules: [], requirements: [] }, []).join('\n');
  assert.match(lines, /names no program/);
  assert.ok(!lines.includes('```json'));
  assert.match(lines, /no registered requirement/);
});

test("a Verifier on other work is not given the check-writing section", (t) => {
  const db = store(t);
  const { prompt, facts } = packageOf(t, db, 'run_ver');
  assert.equal(facts.check_writing, null);
  assert.ok(!prompt.includes("## Writing the project's checks"));
  assert.ok(prompt.includes('Verify the work below'));
});
