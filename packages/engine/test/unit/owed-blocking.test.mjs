// Developer test for the driver's ruling on the real M444 run's stall after
// the owner's answer: the owed question (finding_disposition, scope
// disposition_owed) said accept releases the gates, but a High or Critical
// finding blocks whatever its disposition (gates.ts blocks), and fix was
// offered for a finding no check could verify. Now (D1 §9.4; D2 C2):
//   1. a blocking finding is offered lower_and_accept: the human lowers it
//      to medium (severity_history: authority human, the decision) and
//      accepts it, and the gate's finding rules release it;
//   2. plain accept only for a severity that does not block;
//   3. fix only when the finding names a check and criterion that can
//      verify it (findingVerifiable);
//   4. change_spec lowers a blocking finding as 1 does;
//   5. a finding accepted through the earlier question while it blocks is
//      asked once more, through the corrected question.
// Against a scratch store, foreign keys off, the rows the minimum each read
// needs.

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
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { askUndispositioned } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { blocks } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const reviewModule = await import(join(dist, 'design', 'review.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-16T00:00:00.000Z';
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  // A required acceptance check covering R1.1: what a finding naming it and R1.1 can be verified by.
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria)
     VALUES ('chk_1', ?, 'prj_1', 'login', 'pv_1', 'smoke', 1, '["stage","alpha_authorize"]', '.surety/checks/defs/login.json', 'h', 'direct', '["R1.1"]')`,
    AT,
  );
  let seq = 0;
  // A project-scope finding of an Architect, no candidate: owed at once (b).
  const finding = (id, { severity, category = 'defect', check = null, criterion = null }) =>
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
       VALUES (?, ?, 'prj_1', ?, 'project', 'prj_1', NULL, NULL, 'architect', ?, 'the plan names an interface the spec does not', ?, ?, ?, '[]', NULL, 'open', '[]', ?)`,
      id,
      AT,
      ++seq,
      category,
      check,
      severity,
      severity,
      criterion,
    );
  return { db, run, finding };
}

const sweep = (db) => transact(db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' }));
const owedOpen = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed' AND status = 'open'`).all(id);
const keys = (d) => JSON.parse(d.options).map((o) => o.key);
const answer = (db, d, option) => transact(db, HUMAN, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const row = (db, id) => db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
// The gate's finding rules (gates.ts evaluate): it holds a finding that
// blocks; a human's accept of one that does not is released.
const released = (f) => !blocks(f, 'stage') && f.disposition === 'accept' && f.disposition_authority === 'human';

test('1-3: the options by severity and verifiability; every consequence is what the gate then does', (t) => {
  const s = store(t);
  s.finding('fnd_high', { severity: 'high' });
  s.finding('fnd_crit', { severity: 'critical', category: 'contract_conflict' });
  s.finding('fnd_med', { severity: 'medium' });
  s.finding('fnd_fixable', { severity: 'high', check: 'login', criterion: 'R1.1' });
  s.finding('fnd_wrong', { severity: 'high', check: 'login', criterion: 'R9.9' });
  assert.equal(sweep(s.db), 5);
  const [high] = owedOpen(s.db, 'fnd_high');
  assert.deepEqual(keys(high), ['lower_and_accept'], 'High, no check: no plain accept, no fix');
  const lower = JSON.parse(high.options)[0];
  assert.match(lower.consequence_text, /lowered from high to medium by the human owner/);
  assert.match(lower.consequence_text, /no longer holds the gates/);
  assert.deepEqual(keys(owedOpen(s.db, 'fnd_crit')[0]), ['change_spec', 'lower_and_accept'], 'Critical conflict');
  assert.match(JSON.parse(owedOpen(s.db, 'fnd_crit')[0].options)[0].consequence_text, /lowered from critical to medium/, 'change_spec says it lowers');
  const [med] = owedOpen(s.db, 'fnd_med');
  assert.deepEqual(keys(med), ['accept'], 'Medium: accept releases the gates');
  assert.match(JSON.parse(med.options)[0].consequence_text, /no longer holds the gates/);
  const [fixable] = owedOpen(s.db, 'fnd_fixable');
  assert.deepEqual(keys(fixable), ['fix', 'correct_check', 'lower_and_accept'], 'a check and criterion that can verify it: fix; it names a check: correct_check (E152 item 3)');
  assert.match(JSON.parse(fixable.options)[0].consequence_text, /holds the gates until its check login passes after the fix/);
  assert.deepEqual(keys(owedOpen(s.db, 'fnd_wrong')[0]), ['correct_check', 'lower_and_accept'], 'a check that does not cover its criterion: no fix; correct_check, since it names a check (E152 item 3)');
});

test('1: lower_and_accept lowers to medium with the human authority and the decision, accepts, and the gate releases it; Critical too, and change_spec on a blocking conflict', (t) => {
  const s = store(t);
  s.finding('fnd_high', { severity: 'high' });
  s.finding('fnd_crit', { severity: 'critical' });
  s.finding('fnd_conf', { severity: 'high', category: 'contract_conflict' });
  sweep(s.db);
  assert.equal(released(row(s.db, 'fnd_high')), false, 'held before');
  const [d] = owedOpen(s.db, 'fnd_high');
  answer(s.db, d, 'lower_and_accept');
  const f = row(s.db, 'fnd_high');
  assert.deepEqual([f.status, f.disposition, f.disposition_authority, f.effective_severity], ['dispositioned', 'accept', 'human', 'medium']);
  const [h] = JSON.parse(f.severity_history);
  assert.deepEqual([h.from, h.to, h.authority, h.decision], ['high', 'medium', 'human', d.id]);
  assert.equal(released(f), true, 'the gate releases it');
  answer(s.db, owedOpen(s.db, 'fnd_crit')[0], 'lower_and_accept');
  assert.equal(released(row(s.db, 'fnd_crit')), true, 'Critical lowered by the human (D2 C2) and released');
  answer(s.db, owedOpen(s.db, 'fnd_conf')[0], 'change_spec');
  const c = row(s.db, 'fnd_conf');
  assert.deepEqual([c.effective_severity, c.disposition, released(c)], ['medium', 'accept', true], 'change_spec lowers a blocking conflict, so "accepted meanwhile" releases it');
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'spec_change'`).get().n, 1);
  assert.equal(sweep(s.db), 0, 'nothing is asked again');
});

test('3: fix, where offered, registers fix work; the severity is not lowered', (t) => {
  const s = store(t);
  s.finding('fnd_fixable', { severity: 'high', check: 'login', criterion: 'R1.1' });
  sweep(s.db);
  answer(s.db, owedOpen(s.db, 'fnd_fixable')[0], 'fix');
  const f = row(s.db, 'fnd_fixable');
  assert.deepEqual([f.disposition, f.effective_severity], ['fix', 'high']);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'fix'`).get().n, 1);
});

test('5: a finding accepted through the earlier owed question while it blocks is asked once more, through the corrected question; never twice; not when it does not block, nor after the corrected form', (t) => {
  const s = store(t);
  // The earlier question's form (fix, change_spec, accept), answered accept by the human.
  const old = (id, finding) =>
    s.run(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status, answer, consumed_at)
       VALUES (?, ?, 'prj_1', ?, 'finding_disposition', 'finding', ?, 1, 'disposition_owed', 'q', '[{"key":"fix"},{"key":"change_spec"},{"key":"accept"}]', '{}', 1, 'h', '[]', '{}', ?, 'consumed', '{"option":"accept","note":null,"actor":"human"}', ?)`,
      id,
      AT,
      id === 'dec_a' ? 1 : 2,
      finding,
      AT,
      AT,
    );
  const accepted = (id, severity) => {
    s.finding(id, { severity, category: 'contract_conflict' });
    s.run(`UPDATE findings SET status = 'dispositioned', disposition = 'accept', disposition_authority = 'human', disposition_by = 'human', disposition_at = ? WHERE id = ?`, AT, id);
  };
  accepted('fnd_live', 'high');
  old('dec_a', 'fnd_live');
  accepted('fnd_med', 'medium');
  old('dec_b', 'fnd_med');
  assert.equal(released(row(s.db, 'fnd_live')), false, 'the stall: accepted, and still held');
  assert.equal(sweep(s.db), 1, 'only the blocking one');
  const [d] = owedOpen(s.db, 'fnd_live');
  assert.notEqual(d.id, 'dec_a', 'a new decision');
  assert.deepEqual(keys(d), ['change_spec', 'lower_and_accept'], 'the corrected question');
  assert.match(d.question, /was accepted, but at severity high an accepted finding still holds the gates/);
  assert.equal(sweep(s.db), 0, 'asked once');
  answer(s.db, d, 'lower_and_accept');
  assert.equal(released(row(s.db, 'fnd_live')), true);
  assert.equal(sweep(s.db), 0, 'answered: never again');
  // A finding whose corrected question was consumed is not re-asked, even
  // if it blocks again (raised by a role's severity change, for one).
  s.run(`UPDATE findings SET effective_severity = 'high' WHERE id = 'fnd_live'`);
  assert.equal(sweep(s.db), 0, 'after the corrected form, no recovery');
});

// F4 (Sean's ruling, 2026-10-18; the driver's rulings on 9ff79c0): a
// finding a confirmed design review filed (its id among the review's
// `findings`) is offered fix even where no check can verify it, and each
// consequence says what the disposition and the gate then do.
function reviewed(s, ids) {
  s.run(`INSERT INTO design_reviews (id, created_at, project, trigger, subject, verdicts, confirmed_by, confirmation_decision, findings) VALUES ('drv_1', ?, 'prj_1', 'owner_command', '{}', '[]', 'human', 'dec_conf', ?)`, AT, JSON.stringify(ids));
}
const fixText = (db, id) => JSON.parse(owedOpen(db, id)[0].options).find((o) => o.key === 'fix')?.consequence_text;
const workCount = (db, kind, id) => db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = ? AND json_extract(subject, '$.finding') = ?`).get(kind, id).n;

test('F4: a design review finding no check can verify is offered fix; nothing will resolve one naming no check, and the text says so and names the only re-disposition route; fix registers fix and check_correction work', (t) => {
  const s = store(t);
  s.finding('fnd_bare', { severity: 'medium' });
  s.finding('fnd_crit_only', { severity: 'medium', criterion: 'R1.1' });
  s.finding('fnd_linked', { severity: 'medium', check: 'login', criterion: 'R1.1' });
  s.finding('fnd_plain', { severity: 'medium' });
  reviewed(s, ['fnd_bare', 'fnd_crit_only', 'fnd_linked']);
  sweep(s.db);
  assert.deepEqual(keys(owedOpen(s.db, 'fnd_bare')[0]), ['fix', 'accept'], 'fix offered on the unlinked review finding');
  assert.deepEqual(keys(owedOpen(s.db, 'fnd_plain')[0]), ['accept'], 'the M444 rule for every other finding');
  const bare = fixText(s.db, 'fnd_bare');
  assert.match(bare, /registers fix work/);
  assert.match(bare, /check_correction work for the Verifier/);
  assert.match(bare, /names no criterion and no check, and nothing in the engine ever gives a finding a check, so nothing in the engine will resolve it \(the check_correction work does not\)/);
  assert.match(bare, /until it is dispositioned otherwise/);
  assert.match(bare, /only a Reviewer's report can/);
  assert.doesNotMatch(bare, /as it stands/);
  assert.match(fixText(s.db, 'fnd_crit_only'), /names criterion R1\.1 but no check/);
  const linked = fixText(s.db, 'fnd_linked');
  assert.match(linked, /until its check login passes after this disposition/);
  assert.doesNotMatch(linked, /check_correction/);
  answer(s.db, owedOpen(s.db, 'fnd_bare')[0], 'fix');
  assert.deepEqual([workCount(s.db, 'fix', 'fnd_bare'), workCount(s.db, 'check_correction', 'fnd_bare')], [1, 1], 'fix work and check_correction work');
  answer(s.db, owedOpen(s.db, 'fnd_linked')[0], 'fix');
  assert.deepEqual([workCount(s.db, 'fix', 'fnd_linked'), workCount(s.db, 'check_correction', 'fnd_linked')], [1, 0], 'a verifiable one routes no check_correction');
});

test('F4: in the conformance phase the fix text says no fix work and no check_correction work, as recordDisposition does; with no effective protected version verifiability is unknown', (t) => {
  const s = store(t);
  s.finding('fnd_bare', { severity: 'medium' });
  reviewed(s, ['fnd_bare']);
  s.run(`UPDATE projects SET adoption = '{}' WHERE id = 'prj_1'`);
  sweep(s.db);
  const conf = fixText(s.db, 'fnd_bare');
  assert.match(conf, /conformance phase, so nothing else is registered now: no fix work, no check_correction work/);
  assert.doesNotMatch(conf, /registers fix work|registers check_correction/);
  assert.match(conf, /nothing in the engine will resolve it:/);
  answer(s.db, owedOpen(s.db, 'fnd_bare')[0], 'fix');
  assert.deepEqual([workCount(s.db, 'fix', 'fnd_bare'), workCount(s.db, 'check_correction', 'fnd_bare')], [0, 0], 'as the text says');

  const u = store(t);
  u.finding('fnd_bare', { severity: 'medium' });
  reviewed(u, ['fnd_bare']);
  u.run(`UPDATE protected_versions SET effective_from = NULL`);
  sweep(u.db);
  const unknown = fixText(u.db, 'fnd_bare');
  assert.match(unknown, /Whether a check can verify it is unknown \(the project has no effective protected version\)/);
  assert.doesNotMatch(unknown, /No check named by the finding can verify it/);
});

test('F4: the confirm option of design_verdicts states the link each filing delta will carry, or no criterion, no check', (t) => {
  const s = store(t);
  const { DESIGN_VERDICTS } = reviewModule;
  const verdicts = [
    { target: 'android', screen: 'S2', verdict: 'deltas', status: 'proposed', evidence: [], deltas: [{ owner_words: 'a', kind: 'implementation', criterion: 'R1.1', check: 'login' }, { owner_words: 'b', kind: 'design' }, { owner_words: 'c', kind: 'both', state: 'empty' }] },
  ];
  s.run(`INSERT INTO design_reviews (id, created_at, project, trigger, subject, verdicts) VALUES ('drv_2', ?, 'prj_1', 'owner_command', '{}', ?)`, AT, JSON.stringify(verdicts));
  const preview = transact(s.db, HUMAN, (tx) => DESIGN_VERDICTS.preview(tx, { subject_id: 'drv_2' }));
  const confirm = preview.options.find((o) => o.key === 'confirm').consequence;
  assert.match(confirm, /Each finding carries the criterion and check its delta names, and neither where it names none/);
  assert.match(confirm, /as proposed: android S2: criterion R1\.1, check login; android S2 \(empty\): no criterion, no check\./);
  assert.doesNotMatch(confirm, /android S2: no criterion.*android S2: no criterion/, 'the design delta is not listed');
});
