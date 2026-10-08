// Developer tests for what each role is told (D2 §1.3; the dress rehearsal's
// first engine finding, SEAM §171): the result schema names every field the
// engine reads from that role; a Reviewer gets the candidate's diff, the ids
// of the findings that apply to the candidate, the sign-offs required and the
// assessments awaiting it; a fix Builder gets its finding. Against a scratch
// store with the engine's migrations, a scratch package directory and a
// scratch git repository.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { contextFacts } = await import(join(dist, 'store', 'reads.js'));
const { moduleBasis } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { writeContextPackage, resultSchema } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { candidateDiff, DIFF_CAP_BYTES } = await import(join(dist, 'invoke', 'sandbox', 'prepare.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

const AT = '2026-10-02T00:00:00.000Z';
const R0 = 'c'.repeat(40);
const R1 = 'a'.repeat(40);
const R2 = 'b'.repeat(40);
const KINDS = ['prompt', 'instructions', 'result_schema', 'requirement', 'adr', 'constraint', 'phase_plan', 'interface', 'diff', 'acceptance_content_hash', 'prior_run'];

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function store(t, { tier = 'T2' } = {}) {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', ?, '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
    tier,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_2', ?, 'prj_1', 'main', 'cand_1', 1)`, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'developing')`, AT, R1, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_2', ?, 'prj_1', 2, ?, 'lin_2', ?, 'engine_cadence', 'developing')`, AT, R2, AT);
  run(`INSERT INTO revisions (id, created_at, project, sha, lineage, parent_sha, kind, created_by_run, recorded_at) VALUES ('rev_0', ?, 'prj_1', ?, 'lin_1', ?, 'engine_commit', NULL, ?)`, AT, R1, R0, AT);
  const finding = (id, seq, scope, candidate, status, severity, message, check = null) =>
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, status)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'run_v', 'verifier', 'defect', ?, ?, ?, ?, ?)`,
      id,
      AT,
      seq,
      scope,
      candidate ?? 'prj_1',
      candidate,
      message,
      check,
      severity,
      severity,
      status,
    );
  finding('fnd_1', 1, 'candidate', 'cand_2', 'open', 'high', 'login accepts an empty password', 'login');
  finding('fnd_2', 2, 'lineage', 'cand_1', 'open', 'medium', 'the session never expires');
  finding('fnd_3', 3, 'candidate', 'cand_2', 'resolved', 'low', 'a typo');
  finding('fnd_4', 4, 'candidate', 'cand_9', 'open', 'low', 'another candidate entirely');
  run(
    `INSERT INTO applicability_assessments (id, created_at, project, finding, candidate, proposed_by_run, evidence, reason, status)
     VALUES ('appl_1', ?, 'prj_1', 'fnd_2', 'cand_2', 'run_v', 'rec_e', 'the path is gone', 'proposed')`,
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
  item('wi_rev', 1, 'review', { candidate: 'cand_2' });
  item('wi_rev1', 2, 'review', { candidate: 'cand_1' });
  item('wi_ver', 3, 'verification', { candidate: 'cand_2' });
  item('wi_fix', 4, 'fix', { finding: 'fnd_1' });
  const runRow = (id, seq, workItem, role, contentHash) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, content_hash)
       VALUES (?, ?, 'prj_1', ?, ?, ?, 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0, ?)`,
      id,
      AT,
      seq,
      workItem,
      role,
      R2,
      AT,
      contentHash,
    );
  runRow('run_rev', 1, 'wi_rev', 'reviewer', 'hash_2');
  runRow('run_rev1', 2, 'wi_rev1', 'reviewer', 'hash_1');
  runRow('run_ver', 3, 'wi_ver', 'verifier', null);
  runRow('run_fix', 4, 'wi_fix', 'builder', null);
  return db;
}

const claimOf = (facts) => ({ run: facts.run.id, role: facts.run.role, work_item: facts.work_item.id, work_kind: facts.work_item.kind, base_revision: facts.run.base_revision, attempt: null });

function packageOf(t, facts, diff = null) {
  const dir = join(scratch(t), 'context');
  writeContextPackage(dir, claimOf(facts), facts, { probe: false, diff });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const read = (p) => readFileSync(join(dir, p), 'utf8');
  return { manifest, read, entry: (p) => manifest.files.find((f) => f.path === p) };
}

test("a Reviewer's facts: the candidate its work item names, the findings that apply to it by id, the sign-offs its tier requires, the assessments awaiting it, the previous candidate as the diff's base", (t) => {
  const db = store(t);
  const facts = contextFacts(db, { run: 'run_rev' });
  assert.deepEqual(facts.candidate, { id: 'cand_2', revision: R2, acceptance_content_hash: 'hash_2' });
  assert.deepEqual(
    facts.review.findings.map((f) => [f.id, f.status, f.severity, f.message]),
    [
      ['fnd_1', 'open', 'high', 'login accepts an empty password'],
      ['fnd_2', 'open', 'medium', 'the session never expires'],
    ],
    "the open findings of the candidate and of its predecessor's lineage; not a resolved one, not another candidate's",
  );
  assert.deepEqual(facts.review.signoffs, [{ role: 'reviewer', scope: 'candidate' }]);
  assert.deepEqual(facts.review.assessments.map((a) => a.id), ['appl_1']);
  assert.deepEqual(facts.review.diff_base, { revision: R1, from: 'previous_candidate' });
  assert.equal(facts.finding, null);
});

test("the first candidate's diff is taken from the parent of the first revision the engine recorded", (t) => {
  const db = store(t);
  assert.deepEqual(contextFacts(db, { run: 'run_rev1' }).review.diff_base, { revision: R0, from: 'first_recorded_parent' });
  db.prepare('DELETE FROM revisions').run();
  assert.deepEqual(contextFacts(db, { run: 'run_rev1' }).review.diff_base, { revision: null, from: null }, 'none is known: null, not a guess');
});

test("at T3 the Reviewer is told each scope module's sign-off and the security sign-off; a Verifier is told no sign-off", (t) => {
  const db = store(t, { tier: 'T3' });
  db.prepare(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_1', ?, 'prj_1', 'auth', '["src/auth/"]')`).run(AT);
  db.prepare(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_2', ?, 'prj_1', 'web', '["web/"]')`).run(AT);
  // Slice 20 (D3 §4.1): its scopes' modules. While the presence is unread,
  // every module may be in the deployment scope, so each is asked.
  assert.deepEqual(contextFacts(db, { run: 'run_rev' }).review.signoffs.map((s) => s.module ?? s.scope), ['candidate', 'auth', 'web', 'security']);
  // auth is present at the revision, web is not.
  db.prepare(`UPDATE candidates SET module_presence = ? WHERE id = 'cand_2'`).run(JSON.stringify({ modules: ['mod_1'], read_at: AT, basis: moduleBasis(db, 'prj_1') }));
  assert.deepEqual(contextFacts(db, { run: 'run_rev' }).review.signoffs, [
    { role: 'reviewer', scope: 'candidate' },
    { role: 'reviewer', scope: 'module', module: 'auth' },
    { role: 'reviewer', scope: 'security' },
  ]);
  const verifier = contextFacts(db, { run: 'run_ver' });
  assert.equal(verifier.candidate.id, 'cand_2');
  assert.deepEqual(verifier.review.signoffs, []);
  assert.deepEqual(verifier.review.findings.map((f) => f.id), ['fnd_1', 'fnd_2']);
});

test("a fix Builder's facts: the finding its work item names", (t) => {
  const db = store(t);
  const facts = contextFacts(db, { run: 'run_fix' });
  assert.deepEqual([facts.finding.id, facts.finding.severity, facts.finding.message, facts.finding.check], ['fnd_1', 'high', 'login accepts an empty password', 'login']);
  assert.equal(facts.review, null);
  assert.equal(facts.candidate, null);
});

test("each role's result schema names the fields the engine reads from that role, and only those", () => {
  const props = (role) => Object.keys(resultSchema(role).properties).sort();
  assert.deepEqual(props('builder'), ['checkpoint', 'nominate', 'status', 'summary']);
  assert.deepEqual(props('architect'), ['checkpoint', 'status', 'summary']);
  assert.deepEqual(props('verifier'), ['applicability', 'findings', 'proposal', 'severity_changes', 'status', 'summary']);
  assert.deepEqual(props('reviewer'), ['alpha_exception_proposals', 'assessments', 'dispositions', 'findings', 'proposal_approval', 'severity_changes', 'signoffs', 'status', 'summary']);
  for (const role of ['builder', 'architect', 'verifier', 'reviewer']) {
    const s = resultSchema(role);
    assert.deepEqual(s.required, ['status', 'summary']);
    assert.equal(s.additionalProperties, false);
  }
  const d = resultSchema('reviewer').properties.dispositions.items;
  assert.deepEqual(d.required, ['finding', 'disposition']);
  assert.deepEqual(d.properties.disposition.enum, ['fix', 'defer', 'accept']);
});

test("the Reviewer's package: the diff, the findings by id, the review facts, its own schema, every file in the manifest under a known kind", (t) => {
  const db = store(t);
  const facts = contextFacts(db, { run: 'run_rev' });
  const diff = { base: R1, base_from: 'previous_candidate', revision: R2, state: 'complete', text: 'diff --git a/x b/x\n', detail: null };
  const pkg = packageOf(t, facts, diff);
  for (const f of pkg.manifest.files) assert.ok(KINDS.includes(f.kind), `${f.path} is of a known kind (${f.kind})`);
  assert.deepEqual([pkg.entry('candidate.diff')?.kind, pkg.entry('candidate.diff')?.source], ['diff', 'cand_2']);
  assert.equal(pkg.read('candidate.diff'), diff.text);
  assert.deepEqual(JSON.parse(pkg.read('findings.json')).findings.map((f) => f.id), ['fnd_1', 'fnd_2']);
  const review = JSON.parse(pkg.read('review.json'));
  assert.deepEqual([review.candidate, review.acceptance_content_hash, review.diff.state, review.signoffs_required.length, review.assessments[0].id], ['cand_2', 'hash_2', 'complete', 1, 'appl_1']);
  assert.ok('dispositions' in JSON.parse(pkg.read('result-schema.json')).properties);
  const prompt = pkg.read('prompt.md');
  for (const want of ['fnd_1 (high)', 'fnd_2 (medium)', 'candidate.diff', '`dispositions`', '`fix` registers fix work']) assert.ok(prompt.includes(want), `the prompt says ${want}`);
  assert.ok(pkg.read('acceptance-content-hash.txt').includes('hash_2'));
});

test("the Verifier's package has the findings by id and no diff or review file; a fix Builder's has its finding and no findings list", (t) => {
  const db = store(t);
  const ver = packageOf(t, contextFacts(db, { run: 'run_ver' }), { base: R1, base_from: 'previous_candidate', revision: R2, state: 'complete', text: 'x', detail: null });
  assert.deepEqual(JSON.parse(ver.read('findings.json')).findings.map((f) => f.id), ['fnd_1', 'fnd_2']);
  assert.equal(ver.entry('candidate.diff'), undefined);
  assert.equal(ver.entry('review.json'), undefined);
  assert.ok(!('dispositions' in JSON.parse(ver.read('result-schema.json')).properties));
  const fix = packageOf(t, contextFacts(db, { run: 'run_fix' }));
  assert.deepEqual([fix.entry('finding.json')?.kind, fix.entry('finding.json')?.source], ['instructions', 'fnd_1']);
  assert.equal(JSON.parse(fix.read('finding.json')).message, 'login accepts an empty password');
  assert.ok(fix.read('prompt.md').includes('Finding fnd_1 (high, defect; the check login shows it fixed)'));
  assert.ok(fix.read('prompt.md').includes('login accepts an empty password'));
  assert.equal(fix.entry('findings.json'), undefined);
  for (const f of [...ver.manifest.files, ...fix.manifest.files]) assert.ok(KINDS.includes(f.kind));
});

test("a diff the package cannot carry whole is said to be so: whole, cut at the cap, only the summary, or none", async (t) => {
  const dir = scratch(t);
  const repo = join(dir, 'repo');
  const g = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'one');
  const first = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  g('commit', '-q', '-am', 'two');
  const second = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'big.txt'), `${'0123456789abcdef'.repeat(64)}\n`.repeat(Math.ceil((DIFF_CAP_BYTES * 1.5) / 1025)));
  g('add', '.');
  g('commit', '-q', '-m', 'big');
  const third = g('rev-parse', 'HEAD');

  configureGit({ deadlineSeconds: 30, outputCap: 8 << 20, home: dir, incarnation: 'inc_unit' });
  const whole = await candidateDiff(repo, { revision: first, from: 'previous_candidate' }, second);
  assert.equal(whole.state, 'complete');
  assert.match(whole.text, /^-one$/m);
  assert.match(whole.text, /^\+two$/m);
  const fromNothing = await candidateDiff(repo, { revision: null, from: null }, second);
  assert.equal(fromNothing.state, 'complete');
  assert.match(fromNothing.text, /new file mode/);
  assert.match(fromNothing.base, /^[0-9a-f]{40}$/, 'the empty tree is named');
  const cut = await candidateDiff(repo, { revision: second, from: 'previous_candidate' }, third);
  assert.equal(cut.state, 'truncated');
  assert.ok(Buffer.byteLength(cut.text) <= DIFF_CAP_BYTES && cut.text.endsWith('\n'));
  assert.match(cut.detail, /bytes, the first/);

  configureGit({ deadlineSeconds: 30, outputCap: 64 << 10, home: dir, incarnation: 'inc_unit' });
  const stat = await candidateDiff(repo, { revision: second, from: 'previous_candidate' }, third);
  assert.equal(stat.state, 'stat_only');
  assert.match(stat.text, /big\.txt/);
  assert.ok(stat.detail);

  const none = await candidateDiff(repo, { revision: 'd'.repeat(40), from: 'previous_candidate' }, third);
  assert.deepEqual([none.state, none.text], ['unavailable', '']);
  assert.ok(none.detail);
});

// ---- E87: the fix loop's check keys, told to each role (path two (b)) ----

// The effective protected version's checks: `login` (required at T2, covers
// R1) and `lint` (not required), with the requirement R1 by its id.
function withChecks(db, { none = false } = {}) {
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'h', 'human', ?, 1, ?, '[".surety/checks/"]')`,
    AT,
    AT,
    AT,
  );
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, assigned_phase, status) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 1, 'approved')`, AT);
  if (none) return;
  const check = (id, key, required, reqs) =>
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, requirement_ids, runner_class)
       VALUES (?, ?, 'prj_1', ?, 'pv_1', 'acceptance', ?, '["stage","alpha_authorize"]', '.surety/checks/x.json', 'h', ?, 'direct')`,
      id,
      AT,
      key,
      required,
      JSON.stringify(reqs),
    );
  check('chk_1', 'login', 1, ['req_1']);
  check('chk_2', 'lint', 0, []);
}

test("E87: the Verifier is told to name a finding's check, with the project's check keys (required ones marked), never their content", (t) => {
  const db = store(t);
  withChecks(db);
  const facts = contextFacts(db, { run: 'run_ver' });
  assert.deepEqual(facts.checks, [
    { key: 'login', requirements: ['R1'], gate_kinds: ['stage', 'alpha_authorize'], required: true },
    { key: 'lint', requirements: [], gate_kinds: ['stage', 'alpha_authorize'], required: false },
  ]);
  const pkg = packageOf(t, facts);
  const prompt = pkg.read('prompt.md');
  assert.match(prompt, /Name in each finding's `check` the key of the project's check whose passing shows it fixed/);
  assert.match(prompt, /Without one, a fix of the finding can never be shown, and the finding stays open\./);
  assert.match(prompt, /- `login` \(required\): covers R1; gate kinds stage, alpha_authorize\./);
  assert.match(prompt, /- `lint`: covers no requirement;/);
  assert.ok(!prompt.includes('.surety/checks/x.json'), 'never a check\'s definition');
  assert.match(JSON.parse(pkg.read('result-schema.json')).properties.findings.items.properties.check.description, /Required for the finding to be resolved by a fix/);
});

test('E87: the Reviewer is told how a fix is resolved, with the same keys', (t) => {
  const db = store(t);
  withChecks(db);
  const prompt = packageOf(t, contextFacts(db, { run: 'run_rev' }), { base: null, base_from: null, revision: 'b'.repeat(40), state: 'complete', text: '', detail: null }).read('prompt.md');
  assert.match(prompt, /A fix is shown done, and the finding resolved, when the finding's `check` passes after your disposition\. A finding with no check cannot be resolved that way: if you raise one, name its check\./);
  assert.match(prompt, /- `login` \(required\)/);
});

test("E87: the fix Builder's task is the fix, resolved when its check passes; the check is protected", (t) => {
  const db = store(t);
  withChecks(db);
  const prompt = packageOf(t, contextFacts(db, { run: 'run_fix' })).read('prompt.md');
  assert.match(prompt, /^Fix the finding below\.$/m);
  assert.ok(!/Build what the stage below asks for/.test(prompt));
  assert.match(prompt, /It is resolved when the check `login` passes on the candidate after your change: make it pass by fixing the code\. The check is protected: do not change it\./);
  db.prepare("UPDATE findings SET \"check\" = NULL WHERE id = 'fnd_1'").run();
  assert.match(packageOf(t, contextFacts(db, { run: 'run_fix' })).read('prompt.md'), /It names no check: describe in your summary what shows it fixed\./);
});

test('E87: with no checks in the effective version, the Verifier is told so plainly; a stage Builder gets no list', (t) => {
  const db = store(t);
  withChecks(db, { none: true });
  assert.match(packageOf(t, contextFacts(db, { run: 'run_ver' })).read('prompt.md'), /The project has no checks in its effective protected version, so no finding can name one\./);
});

// ---- the review of b72b9cc: F1 (the check named is a check of the project), F3, F4 ----

const { unknownCheck } = await import(join(dist, 'invoke', 'choke.js'));
const { earnedEnd, newHandle } = await import(join(dist, 'runtime.js'));

test("F1: the Verifier's and the Reviewer's result schema give a finding's check as an enum of the project's keys", (t) => {
  const db = store(t);
  withChecks(db);
  for (const run of ['run_ver', 'run_rev']) {
    const schema = JSON.parse(packageOf(t, contextFacts(db, { run }), { base: null, base_from: null, revision: 'b'.repeat(40), state: 'complete', text: '', detail: null }).read('result-schema.json'));
    assert.deepEqual(schema.properties.findings.items.properties.check.enum, ['lint', 'login'], run);
  }
  assert.deepEqual(resultSchema('verifier', []).properties.findings.items.properties.check, undefined, 'with no keys, check is left out');
  assert.ok(resultSchema('verifier').properties.findings.items.properties.check, 'without keys given, as before');
});

test('F1: with no checks, or no effective version, the schema allows no check', (t) => {
  const none = store(t);
  withChecks(none, { none: true });
  assert.equal(JSON.parse(packageOf(t, contextFacts(none, { run: 'run_ver' })).read('result-schema.json')).properties.findings.items.properties.check, undefined);
  const unread = store(t);
  assert.equal(JSON.parse(packageOf(t, contextFacts(unread, { run: 'run_ver' })).read('result-schema.json')).properties.findings.items.properties.check, undefined);
});

test('F1: a finding naming an unknown key makes the result invalid, the reason naming it (bounded); a known key, or none, does not', () => {
  const r = (check) => ({ summary: 's', checkpoint: false, nominate: false, report: { findings: [{ category: 'defect', severity: 'high', message: 'm', ...(check === undefined ? {} : { check }) }] } });
  assert.equal(unknownCheck(r('login'), ['lint', 'login']), null);
  assert.equal(unknownCheck(r(undefined), ['login']), null);
  assert.equal(unknownCheck({ summary: 's', checkpoint: false, nominate: false }, null), null);
  assert.match(unknownCheck(r('logn'), ['lint', 'login']), /names the check "logn", which is not a check of the project \(its checks: lint, login\)/);
  assert.match(unknownCheck(r('login'), null), /no effective protected version, so no check can be named/);
  assert.match(unknownCheck(r('login'), []), /it has none/);
  assert.ok(unknownCheck(r('x'.repeat(500)), ['login']).length < 200, 'bounded');
});

test("F1: the run's end names why its result was not taken", (t) => {
  const handle = newHandle({ run: 'r', project: 'p', work_item: 'w', work_kind: 'verification', role: 'verifier', domain: 'd', invocation: 'i', generation: 1, deadline_at: AT, attempt: null, entry: null });
  handle.result = { valid: false };
  handle.invalidDetail = 'a finding names the check "logn", which is not a check of the project (its checks: login)';
  assert.deepEqual(earnedEnd(handle), { outcome: 'failed', reason: 'invalid_result', reasonText: handle.invalidDetail });
});

test('F3: with no effective protected version, the package says the checks could not be read, not that there are none', (t) => {
  const db = store(t);
  const facts = contextFacts(db, { run: 'run_ver' });
  assert.equal(facts.checks_known, false);
  const prompt = packageOf(t, facts).read('prompt.md');
  assert.match(prompt, /The project's checks could not be read: it has no effective protected version\./);
  assert.ok(!/The project has no checks/.test(prompt));
});

test("F4: a stage Builder's package has no check list", (t) => {
  const db = store(t);
  withChecks(db);
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_stage', ?, 'prj_1', 9, 'stage_build', '{}', 'executing', 'test', 'wi_stage', 1, 0, 0, 0, 0)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_stage', ?, 'prj_1', 9, 'wi_stage', 'builder', 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(AT, 'b'.repeat(40), AT);
  const facts = contextFacts(db, { run: 'run_stage' });
  assert.equal(facts.checks, null);
  const prompt = packageOf(t, facts).read('prompt.md');
  assert.ok(!/project's checks|`login`/.test(prompt), 'no list, no check key');
});
