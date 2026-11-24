// Developer test for the driver's ruling on the real M443 run's second
// silent stall: a finding a Reviewer raised (or left) with no disposition
// held the stage gates, and nothing asked anyone. The owner is now asked
// (finding_disposition, scope disposition_owed): in the Reviewer's report
// transaction, and by the tick's sweep for one that exists already. A
// Verifier's finding is not asked while a review may still come. The
// Reviewer's package states the dispositions and this route. Against a
// scratch store, foreign keys off, the rows the minimum each read needs.

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
const { resultSchema } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { DISPOSITIONS } = await import(join(dist, 'runs', 'report.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-15T00:00:00.000Z';
const LATER = '2026-10-15T00:10:00.000Z';

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
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, 'a'.repeat(40), AT);
  let seq = 0;
  const runOf = (id, role, state, finished) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, outcome, finished_at)
       VALUES (?, ?, 'prj_1', ?, 'wi_' || ?, ?, 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0, ?, ?)`,
      id,
      AT,
      ++seq,
      id,
      role,
      state,
      'a'.repeat(40),
      AT,
      state === 'ended' ? 'completed' : null,
      finished,
    );
  const finding = (id, role, sourceRun, category = 'requirement_conflict', at = AT) =>
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
       VALUES (?, ?, 'prj_1', ?, 'candidate', 'cand_1', 'cand_1', ?, ?, ?, 'validate() coerces numeric strings; R8.4 requires 400', NULL, 'medium', 'medium', '[]', NULL, 'open', '[]', 'R8.4')`,
      id,
      at,
      ++seq,
      sourceRun,
      role,
      category,
    );
  const reviewItem = (runId, source) =>
    run(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, 'review', '{"candidate":"cand_1"}', 'complete', ?, 'cand_1', ?, 0, 0, 0, 0)`,
      `wi_${runId}`,
      AT,
      ++seq,
      source,
      seq,
    );
  return { db, run, runOf, finding, reviewItem };
}

const owed = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed'`).all(id);

test("a Reviewer's undispositioned finding is put to the owner in its report's transaction: change_spec (a requirement_conflict) or accept (Medium: accept releases the gates; no fix, since it names no check); change_spec requests the change and accepts the finding", (t) => {
  const s = store(t);
  s.runOf('run_r', 'reviewer', 'validating', null);
  s.finding('fnd_1', 'reviewer', 'run_r');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1', reviewing: true })), 1);
  const [d] = owed(s.db, 'fnd_1');
  assert.equal(d?.status, 'open', 'one open question');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['change_spec', 'accept']);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'asked once: the sweep raises no second question');
  transact(s.db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'change_spec', preview_hash: d.preview_hash, note: null }));
  const f = s.db.prepare(`SELECT status, disposition, disposition_authority FROM findings WHERE id = 'fnd_1'`).get();
  assert.deepEqual([f.status, f.disposition, f.disposition_authority], ['dispositioned', 'accept', 'human']);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'spec_change'`).get().n, 1, 'the specification change asked for (no approved spec here: its spec_change item is recorded)');
});

test("the sweep: a Verifier's finding is not asked while the engine's review may come (another review run counts for nothing); once that review has reported after it and left it with none, it is; naming no check, it is offered no fix", (t) => {
  const s = store(t);
  s.runOf('run_v', 'verifier', 'ended', AT);
  s.finding('fnd_2', 'verifier', 'run_v', 'defect');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'no review reported since: not yet');
  s.runOf('run_x', 'reviewer', 'ended', LATER);
  s.reviewItem('run_x', 'test');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'a review that is not the engine-queued one: not yet');
  s.runOf('run_r2', 'reviewer', 'ended', LATER);
  s.reviewItem('run_r2', 'verification');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 1);
  const [d] = owed(s.db, 'fnd_2');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['accept'], 'no change_spec for a defect, no fix without a check that can verify it (owed-blocking.test.mjs has fix)');
  transact(s.db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'accept', preview_hash: d.preview_hash, note: null }));
  assert.equal(s.db.prepare(`SELECT disposition FROM findings WHERE id = 'fnd_2'`).get().disposition, 'accept');
});

test("the Reviewer's result schema states the dispositions from the parser's own list and the owner's route for a finding left with none", () => {
  const schema = resultSchema('reviewer');
  const d = schema.properties.dispositions;
  assert.deepEqual(d.items.properties.disposition.enum, [...DISPOSITIONS]);
  assert.match(d.description, /put to the human owner/);
  assert.match(d.description, /requirement_conflict or contract_conflict/);
});

// ---- DECISIONS item 51, finding 3: a finding owed to the owner, decided by store order -----------
//
// "A review reported after the finding" compared the review run's
// finished_at with the finding's created_at, two wall-clock stamps of
// different transactions: a clock stepping back between a review's end and
// a finding raised next made the earlier review read as after it (the
// owner asked while another review was still to come), and the reverse
// postponed the question. Now the run's run.ended seq against the finding's
// place in the store order (migration 0052). The controlled clock is the
// engine's own seam cell (SEAM.md §425), stepped back in-process; the
// finding is raised by raiseFinding and the review run ended by finishRun,
// the production transitions. Where a column of 0052 is absent (the base)
// nothing is written to it, so the same tests reproduce the defect there.

const { raiseFinding } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { finishRun } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { configureWorker } = await import(join(dist, 'testing', 'seam.js'));
const clockCell = new SharedArrayBuffer(8);
configureWorker({ harness: false, barriers: [], shared: null, clock: clockCell, scripted: null, probes: {}, hostChecks: { mode: 'unrun', forced: {} } }, () => {});
const clockOffset = new BigInt64Array(clockCell);
const stepBack = (seconds) => Atomics.add(clockOffset, 0, BigInt(-seconds * 1000));
const hasColumn = (db, table, column) => db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;

function orderStore(t) {
  t.after(() => Atomics.store(clockOffset, 0, 0n));
  const s = store(t);
  s.runOf('run_v', 'verifier', 'ended', AT);
  let gen = 0;
  // A review of the candidate queued by the engine (trigger verification),
  // its run ended now by finishRun, its item complete.
  const review = (id) => {
    s.db.prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, outcome)
       VALUES (?, ?, 'prj_1', ?, ?, 'reviewer', 'one_shot', 'finalizing', 'scripted', '1', 'm', ?, ?, 0, 'completed')`,
    ).run(id, AT, 9000 + ++gen, `wi_${id}`, 'a'.repeat(40), AT);
    s.db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, 'review', '{"candidate":"cand_1"}', 'executing', 'verification', 'cand_1', ?, 0, 0, 0, 0)`,
    ).run(`wi_${id}`, AT, 9000 + gen, gen);
    return {
      end: () => {
        transact(s.db, ENGINE_ACTOR, (tx) => finishRun(tx, { run: id, invocations: {}, recovery: null }));
        s.db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(`wi_${id}`);
        return s.db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(id).finished_at;
      },
    };
  };
  // A Verifier's finding on the candidate, raised now.
  const verifierFinding = () =>
    transact(s.db, ENGINE_ACTOR, (tx) => raiseFinding(tx, { project: 'prj_1', scope: 'candidate', candidate: 'cand_1', run: 'run_v', role: 'verifier', category: 'defect', severity: 'medium', message: 'm' }));
  const sweep = () => transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' }));
  const raisedFacts = (decision) => JSON.parse(s.db.prepare(`SELECT payload FROM events WHERE type = 'decision.raised' AND json_extract(subject, '$.decision') = ?`).get(decision).payload);
  return { ...s, review, verifierFinding, sweep, raisedFacts };
}
const createdAt = (db, f) => db.prepare('SELECT created_at FROM findings WHERE id = ?').get(f).created_at;

test('item 51 finding 3 (a, b): a review ended, the clock steps back, a Verifier finding raised while a second review is pending: not asked until that review ends, then asked exactly once', (t) => {
  const s = orderStore(t);
  const r1 = s.review('run_r1');
  const r1End = r1.end();
  const r2 = s.review('run_r2');
  stepBack(5);
  const f = s.verifierFinding();
  assert.ok(r1End >= createdAt(s.db, f), `the clock stepped back: R1's finished_at ${r1End} is not before the finding's created_at ${createdAt(s.db, f)}`);
  for (let i = 0; i < 3; i++) assert.equal(s.sweep(), 0, `tick ${i + 1}: R1 ended before the finding; R2 is pending: not asked`);
  assert.deepEqual(owed(s.db, f), []);
  r2.end();
  assert.equal(s.sweep(), 1, 'R2 ended after it without dispositioning it: asked');
  for (let i = 0; i < 3; i++) assert.equal(s.sweep(), 0, `tick ${i + 1}: asked once`);
  const [d] = owed(s.db, f);
  assert.equal(d.status, 'open');
  assert.deepEqual([s.raisedFacts(d.id).reviewed_after, s.raisedFacts(d.id).order_basis], [true, 'seq']);
});

test('item 51 finding 3 (c): the opposite order: the finding raised, the clock steps back, the qualifying review ends with another pending: asked at once, not postponed', (t) => {
  const s = orderStore(t);
  const r = s.review('run_r1');
  s.review('run_r3');
  const f = s.verifierFinding();
  stepBack(5);
  const end = r.end();
  assert.ok(end < createdAt(s.db, f), `the clock stepped back: the review's finished_at ${end} is before the finding's created_at ${createdAt(s.db, f)}`);
  assert.equal(s.sweep(), 1, 'the review ended after the finding: asked');
  assert.equal(s.sweep(), 0, 'once');
  assert.equal(owed(s.db, f).length, 1);
});

// Rows written directly: the review's end and the finding stamped the same
// millisecond (d), or recorded before the order existed (e).
function directPair(s, { stamp, runSeq, findingSeq, finding = 'fnd_d', run = 'run_d' }) {
  s.runOf(run, 'reviewer', 'ended', stamp);
  s.reviewItem(run, 'verification');
  if (runSeq !== undefined && hasColumn(s.db, 'runs', 'finished_seq')) s.db.prepare('UPDATE runs SET finished_seq = ? WHERE id = ?').run(runSeq, run);
  s.finding(finding, 'verifier', 'run_v', 'defect', stamp);
  if (findingSeq !== undefined && hasColumn(s.db, 'findings', 'created_seq')) s.db.prepare('UPDATE findings SET created_seq = ? WHERE id = ?').run(findingSeq, finding);
  // A second review of the candidate still to come: only a review after the finding asks.
  s.db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES (?, ?, 'prj_1', ?, 'review', '{"candidate":"cand_1"}', 'eligible', 'verification', 'cand_1', 99, 0, 0, 0, 0)`,
  ).run(`wi_pending_${run}`, AT, 8000 + runSeq);
}

test('item 51 finding 3 (d): the review end and the finding stamped the same millisecond: the store order decides', (t) => {
  {
    const s = orderStore(t);
    directPair(s, { stamp: LATER, runSeq: 100, findingSeq: 150 });
    assert.equal(s.sweep(), 0, 'the review ended before the finding (seq 100 < 150), the same millisecond: not after it');
  }
  {
    const s = orderStore(t);
    directPair(s, { stamp: LATER, runSeq: 200, findingSeq: 150 });
    assert.equal(s.sweep(), 1, 'the review ended after the finding (seq 200 > 150), the same millisecond: asked');
    assert.equal(s.raisedFacts(owed(s.db, 'fnd_d')[0].id).order_basis, 'seq');
  }
});

test('item 51 finding 3 (e): rows recorded before the store order existed are compared on their timestamps, and the question names that fallback', (t) => {
  const s = orderStore(t);
  s.runOf('run_e', 'reviewer', 'ended', LATER);
  s.reviewItem('run_e', 'verification');
  s.finding('fnd_e', 'verifier', 'run_v', 'defect', AT);
  s.db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_pending_e', ?, 'prj_1', 8999, 'review', '{"candidate":"cand_1"}', 'eligible', 'verification', 'cand_1', 99, 0, 0, 0, 0)`,
  ).run(AT);
  assert.equal(s.sweep(), 1, 'by the recorded stamps the review ended after it');
  const facts = s.raisedFacts(owed(s.db, 'fnd_e')[0].id);
  assert.deepEqual([facts.reviewed_after, facts.order_basis], [true, 'timestamp_fallback'], `the basis is named, never seq (${JSON.stringify(facts)})`);
});
