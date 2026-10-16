// Developer test for the driver's ruling on real loop run 3: every stage of
// phase 2 integrated and verified (T2, each candidate's review complete), the
// phase-only check page-static failed, and the phase Verifier signed nothing
// and raised a hygiene finding naming page-static with no criterion. The
// engine parked the phase verification phase_signoff_missing (retry, cancel)
// and asked nothing about the finding: no answer progressed. Now:
//   1. a finding raised by a phase verification, or one whose candidate's
//      review has already reported, is owed to the owner (finding_disposition,
//      scope disposition_owed);
//   2. a phase Verifier's missing sign-off explained by its own open findings
//      parks nothing: the questions are raised in the report's transaction,
//      the work completes, and the phase waits (plan/phase.ts
//      heldForFindings) until each finding is settled, the fix's work done,
//      then asks its Verifier again;
//   3. a missing sign-off with no finding parks as before (M429 (c), M442 (c)).
// fix is offered only where D3 §2.11 lets a check verify the finding (a
// criterion and a required acceptance-origin check covering it), so the
// loop-run-3 finding is offered accept, not fix: see the report.
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
const { askUndispositioned, recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { heldForFindings } = await import(join(dist, 'plan', 'phase.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-16T00:00:00.000Z';
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };

// The loop-run-3 finding, as its Verifier reported it.
const LOOP3 = {
  category: 'hygiene',
  severity: 'low',
  check: 'page-static',
  message: "public/physics/validate.mjs line 1 reads '// ... the three labs'; page-static fails any public/physics/ file matching /three/i. No requirement criterion covers this check.",
};
// One a check can verify (D3 §2.11): R2.2, covered by the acceptance check accept-r2.
const VERIFIABLE = { category: 'defect', severity: 'medium', check: 'accept-r2', criterion: 'R2.2', message: '/sum answers 200 for a=1e400.' };

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
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  // page-static: phase-only, acceptance origin, kind smoke, covering no criterion (as in the loop-3 store).
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, origin)
     VALUES ('chk_ps', ?, 'prj_1', 'page-static', 'pv_1', 'smoke', 1, '["phase"]', '.surety/checks/defs/page-static.json', 'h', 'direct', '[]', 'acceptance')`,
    AT,
  );
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, origin)
     VALUES ('chk_r2', ?, 'prj_1', 'accept-r2', 'pv_1', 'acceptance', 1, '["stage","phase","alpha_authorize"]', '.surety/checks/defs/accept-r2.json', 'h', 'direct', '["R2.2"]', 'acceptance')`,
    AT,
  );
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, 'a'.repeat(40), AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, bundle) VALUES ('plan_2', ?, 'prj_1', 2, ?, '.surety/phases/phase-2.json', 1, 1, 'pb_1')`, AT, 'c'.repeat(40));
  let seq = 0;
  const item = (id, kind, subject, status = 'executing') =>
    run(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'test', ?, 1, 0, 0, 0, 0)`,
      id,
      AT,
      ++seq,
      kind,
      JSON.stringify(subject),
      status,
      id,
    );
  // The candidate's stage review, reported (T2).
  item('wi_review', 'review', { candidate: 'cand_1' }, 'complete');
  // The phase Verifier's run, its result the report given.
  const phaseVerifier = (report) => {
    item('wi_pv', 'phase_verification', { candidate: 'cand_1', phase_plan: 'plan_2' });
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value)
       VALUES ('run_pv', ?, 'prj_1', ?, 'wi_pv', 'verifier', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, ?)`,
      AT,
      ++seq,
      'a'.repeat(40),
      AT,
      JSON.stringify({ report }),
    );
    transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: 'run_pv' }));
  };
  return { db, run, phaseVerifier };
}

const owedOpen = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed' AND status = 'open'`).all(id);
const keys = (d) => JSON.parse(d.options).map((o) => o.key);
const answer = (db, d, option) => transact(db, HUMAN, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const workItem = (db, id) => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
const reported = (db) => db.prepare(`SELECT * FROM findings WHERE source_run = 'run_pv'`).all();
const blockers = (db) => db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = 'wi_pv'`).all();
// The run ends and its work completes, as the run-end protocol does.
const complete = (s) => s.run(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_pv'`);

test('the loop-run-3 shape: no sign-off, a no-criterion hygiene finding naming page-static: no park, the finding owed at once (accept; no fix, D3 §2.11), the phase waits for it and then asks again', (t) => {
  const s = store(t);
  s.phaseVerifier({ findings: [LOOP3], signoffs: [] });
  const [f] = reported(s.db);
  assert.equal(f.check, 'page-static');
  assert.equal(workItem(s.db, 'wi_pv').status, 'executing', 'not parked: the run end completes it');
  assert.equal(workItem(s.db, 'wi_pv').blocker, null);
  assert.deepEqual(blockers(s.db), [], 'no retry/cancel question');
  const [d] = owedOpen(s.db, f.id);
  assert.ok(d, 'the finding is put to the owner in the same transaction');
  assert.deepEqual(keys(d), ['accept'], 'low, and no check can verify a finding naming no criterion (D3 §2.11 condition 1): accept only');
  complete(s);
  assert.equal(heldForFindings(s.db, 'wi_pv'), 'waiting', 'the phase waits on the owner, without asking its Verifier again');
  answer(s.db, d, 'accept');
  assert.equal(heldForFindings(s.db, 'wi_pv'), 'settled', 'answered: the phase asks its Verifier again (next generation)');
});

test('a finding a check can verify: fix offered; fix registers fix work, and the phase waits for it', (t) => {
  const s = store(t);
  s.phaseVerifier({ findings: [VERIFIABLE], signoffs: [] });
  const [f] = reported(s.db);
  const [d] = owedOpen(s.db, f.id);
  assert.deepEqual(keys(d), ['fix', 'accept']);
  complete(s);
  answer(s.db, d, 'fix');
  const fixes = s.db.prepare(`SELECT * FROM work_items WHERE kind = 'fix' AND json_extract(subject, '$.finding') = ?`).all(f.id);
  assert.equal(fixes.length, 1, 'fix work for a Builder');
  assert.equal(heldForFindings(s.db, 'wi_pv'), 'waiting', 'while its fix work is open (its integration nominates a new candidate, whose phase verification is its own)');
  s.run(`UPDATE work_items SET status = 'complete' WHERE id = ?`, fixes[0].id);
  assert.equal(heldForFindings(s.db, 'wi_pv'), 'settled');
});

test('no sign-off and no finding: parked phase_signoff_missing, as before (M429 (c), M442 (c))', (t) => {
  const s = store(t);
  s.phaseVerifier({ signoffs: [] });
  assert.equal(workItem(s.db, 'wi_pv').status, 'parked');
  assert.match(workItem(s.db, 'wi_pv').blocker, /phase_signoff_missing/);
  complete(s);
  assert.equal(heldForFindings(s.db, 'wi_pv'), null, 'not held for findings');
});

test('a sign-off with a finding: not held, the finding owed as any', (t) => {
  const s = store(t);
  s.phaseVerifier({ findings: [LOOP3], signoffs: [{ scope: 'phase' }] });
  assert.equal(workItem(s.db, 'wi_pv').status, 'executing');
  complete(s);
  assert.equal(heldForFindings(s.db, 'wi_pv'), null);
  const [f] = reported(s.db);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 1, 'owed at the next sweep');
  assert.equal(owedOpen(s.db, f.id).length, 1);
});
