// Developer tests for the Builder's write scope in its packages (real
// Inkwell run, fix work wi_01M5336CXQ8KY0P6Y98FRE58P9): a Verifier's defect
// asked that ADR-004 be "updated alongside" the code; the fix Builder edited
// the ADR and the architecture beside server.mjs, and each of its four runs
// was refused whole (`diff_violation`), its repairs told nothing of why.
// - validateDiff names every path the role may not change, and the run's
//   detail keeps them;
// - the repair's context names the refusal and each path, to leave
//   unchanged (with the one path a run recorded before the detail names);
// - a Builder's package (stage, fix, repair) says nothing under .surety/ is
//   its to change, and that architecture or ADR text disagreeing with an
//   approved spec change is the Architect's; a qualification attempt's says
//   none of it;
// - the finding schema and the Verifier's and Reviewer's prompts say a
//   finding is fixed in the code and not to ask a Builder for .surety/.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { contextFacts, diffViolationFacts } = await import(join(dist, 'store', 'reads.js'));
const { writeContextPackage, resultSchema, BUILDER_SCOPE_TEXT, FIX_IS_CODE_TEXT } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { validateDiff } = await import(join(dist, 'git', 'snapshot.js'));

const AT = '2026-10-16T00:00:00.000Z';
const R1 = 'a'.repeat(40);
const ADR_TEXT = 'the run changed .surety/adrs/ADR-004.md: .surety/adrs/ADR-004.md is under .surety/, which a builder may not change';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function store(t) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", criterion, proposed_severity, effective_severity, status)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'prj_1', NULL, 'run_v', 'verifier', 'defect', ?, 'acceptance-r8', 'R8.2', 'medium', 'medium', 'dispositioned')`,
    AT,
    'server.mjs answers 400 for a body over 100 KB; R8.2 now requires 413. The architecture text (ADR-004) also still says 400 and should be updated alongside.',
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
  item('wi_fix', 1, 'fix', { finding: 'fnd_1' });
  item('wi_ver', 2, 'verification', { candidate: 'cand_1' });
  const runRow = (id, seq, workItem, role, state, reason = {}) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, outcome, reason_class, reason_text, reason_detail)
       VALUES (?, ?, 'prj_1', ?, ?, ?, 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0, ?, ?, ?, ?)`,
      id,
      AT,
      seq,
      workItem,
      role,
      state,
      R1,
      AT,
      reason.outcome ?? null,
      reason.class ?? null,
      reason.text ?? null,
      reason.detail === undefined ? null : JSON.stringify(reason.detail),
    );
  return { db, runRow };
}

const claimOf = (facts, attempt = null) => ({ run: facts.run.id, role: facts.run.role, work_item: facts.work_item.id, work_kind: facts.work_item.kind, base_revision: facts.run.base_revision, attempt });

function packageOf(t, facts, attempt = null) {
  const dir = join(scratch(t), 'context');
  writeContextPackage(dir, claimOf(facts, attempt), facts, { probe: false });
  return (p) => readFileSync(join(dir, p), 'utf8');
}

test('validateDiff names every path a builder may not change, the first in its text, and keeps the text it gave before', async (t) => {
  const dir = scratch(t);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.surety', 'adrs'), { recursive: true });
  mkdirSync(join(repo, '.surety', 'architecture'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  for (const [p, c] of [['server.mjs', 'a\n'], ['.surety/adrs/ADR-004.md', '400\n'], ['.surety/architecture/architecture.md', '400\n']]) writeFileSync(join(repo, p), c);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 22, home: dir, incarnation: 'inc_unit' });
  const caps = { files: 100, bytes: 1 << 20, fileBytes: 1 << 20 };
  for (const [p, c] of [['server.mjs', 'b\n'], ['.surety/adrs/ADR-004.md', '413\n'], ['.surety/architecture/architecture.md', '413\n']]) writeFileSync(join(repo, p), c);
  g('add', '-A');
  const tree = g('write-tree');
  const diff = await validateDiff(repo, base, tree, 'builder', caps, ['.surety/checks/']);
  assert.equal(diff.violation?.klass, 'diff_violation');
  assert.equal(diff.violation.text, ADR_TEXT, 'the refusal text is the one a run gave before');
  assert.equal(diff.violation.path, '.surety/adrs/ADR-004.md');
  assert.deepEqual(diff.violation.paths, ['.surety/adrs/ADR-004.md', '.surety/architecture/architecture.md'], 'every refused path, the code change not among them');
  // Code alone is a builder's.
  g('checkout', '-q', 'HEAD', '--', '.surety');
  g('add', '-A');
  assert.equal((await validateDiff(repo, base, g('write-tree'), 'builder', caps, ['.surety/checks/'])).violation, null);
});

test("a fix Builder's repair after a diff_violation is told the refusal and each path, to leave unchanged", (t) => {
  const { db, runRow } = store(t);
  runRow('run_1', 1, 'wi_fix', 'builder', 'ended', { outcome: 'failed', class: 'diff_violation', text: ADR_TEXT, detail: { paths: ['.surety/adrs/ADR-004.md', '.surety/architecture/architecture.md'] } });
  runRow('run_2', 2, 'wi_fix', 'builder', 'executing');
  assert.deepEqual(diffViolationFacts(db, 'wi_fix', 'run_2'), { run: 'run_1', text: ADR_TEXT, paths: ['.surety/adrs/ADR-004.md', '.surety/architecture/architecture.md'] });
  const facts = contextFacts(db, { run: 'run_2' });
  assert.deepEqual(facts.diff_violation?.paths, ['.surety/adrs/ADR-004.md', '.surety/architecture/architecture.md']);
  const read = packageOf(t, facts);
  const prompt = read('prompt.md');
  assert.match(prompt, /## Your last run was refused/);
  assert.ok(prompt.includes(`Your last run (run_1) was refused whole, and nothing of it was kept: ${ADR_TEXT}.`), prompt);
  assert.ok(prompt.includes('- `.surety/adrs/ADR-004.md`') && prompt.includes('- `.surety/architecture/architecture.md`'), 'each path is named');
  assert.match(prompt, /Leave each of them unchanged in this run/);
  // The fix package: the code only, the .surety/ part of the finding not the Builder's.
  assert.match(prompt, /## What you may change/);
  for (const line of BUILDER_SCOPE_TEXT) assert.ok(prompt.includes(line), `the Builder's scope: ${line}`);
  assert.match(prompt, /If its message also asks for a change under `\.surety\/`.*that part is not yours: leave it unchanged/);
  assert.match(read('instructions.md'), /Change the code only: nothing under `\.surety\/` is a Builder's to change/);
});

test('a run recorded before the detail was kept: the one path its refusal names; a run that did not end on diff_violation: nothing', (t) => {
  const { db, runRow } = store(t);
  runRow('run_1', 1, 'wi_fix', 'builder', 'ended', { outcome: 'failed', class: 'diff_violation', text: ADR_TEXT });
  runRow('run_2', 2, 'wi_fix', 'builder', 'executing');
  assert.deepEqual(diffViolationFacts(db, 'wi_fix', 'run_2'), { run: 'run_1', text: ADR_TEXT, paths: ['.surety/adrs/ADR-004.md'] });
  // A caps refusal names no path: the text alone.
  db.prepare(`UPDATE runs SET reason_text = 'the run changed 600 files, more than snapshot_max_files (500)' WHERE id = 'run_1'`).run();
  const caps = diffViolationFacts(db, 'wi_fix', 'run_2');
  assert.deepEqual(caps.paths, []);
  assert.match(packageOf(t, contextFacts(db, { run: 'run_2' }))('prompt.md'), /more than snapshot_max_files \(500\)\.\nDo not repeat what it names/);
  // Another failure, or none: no such section.
  db.prepare(`UPDATE runs SET reason_class = 'invalid_result' WHERE id = 'run_1'`).run();
  assert.equal(diffViolationFacts(db, 'wi_fix', 'run_2'), null);
  const prompt = packageOf(t, contextFacts(db, { run: 'run_2' }))('prompt.md');
  assert.doesNotMatch(prompt, /Your last run was refused/);
  assert.match(prompt, /## What you may change/, "a first fix run is told its scope all the same");
});

test("a qualification attempt's package says nothing of the Builder's scope", (t) => {
  const { db, runRow } = store(t);
  runRow('run_1', 1, 'wi_fix', 'builder', 'executing');
  // An attempt binds no finding (its package is the canary's).
  const read = packageOf(t, { ...contextFacts(db, { run: 'run_1' }), finding: null }, { id: 'att_1' });
  assert.doesNotMatch(read('prompt.md'), /What you may change|\.surety\//);
  assert.doesNotMatch(read('instructions.md'), /\.surety\//);
});

test("a finding is fixed in the code: the schema and the Verifier's prompt say not to ask a Builder for .surety/", (t) => {
  const { db, runRow } = store(t);
  runRow('run_v', 1, 'wi_ver', 'verifier', 'executing');
  const message = resultSchema('verifier').properties.findings.items.properties.message.description;
  assert.ok(message.includes(FIX_IS_CODE_TEXT), message);
  assert.match(FIX_IS_CODE_TEXT, /the Architect's to revise/);
  assert.ok(resultSchema('reviewer').properties.findings.items.properties.message.description.includes(FIX_IS_CODE_TEXT));
  const facts = contextFacts(db, { run: 'run_v' });
  // A Verifier with a candidate to report on.
  const withCandidate = { ...facts, candidate: { id: 'cand_1', revision: R1, acceptance_content_hash: null }, review: { findings: [], assessments: [], signoffs: [], diff_base: { revision: null, from: null } } };
  assert.ok(packageOf(t, withCandidate)('prompt.md').includes(FIX_IS_CODE_TEXT));
  assert.doesNotMatch(packageOf(t, withCandidate)('prompt.md'), /## What you may change/, "the Builder's scope is the Builder's");
});
