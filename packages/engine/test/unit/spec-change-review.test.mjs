// Developer tests for the slice-36 review's findings (the driver's rulings,
// 2026-10-14): S1 an assessment resolves only in the transaction that
// records its run's report or captured correction; S2 a pending proposal
// whose impact cannot be computed is refused and frees the slot; S3 a
// correction completes only with every obligation resolved; M1 the current
// phase and the later ones; M2, M3, M4, N1, N2 order by the store, never by
// wall time; N3 an assessment names a check of the effective version.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { recordRunReport } = await import(join(dist, 'store', 'transitions', 'accept.js'));
const { getWorkItem } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { stopAfterExitOf } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { resultAfterLoss } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { continuationFacts } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const { correctionApplied, correctionFacts, phasesTouched, specChangeKind } = await import(join(dist, 'spec', 'change.js'));
const { nominatedSince } = await import(join(dist, 'adopt', 'conformance.js'));
const { findingsSincePublication } = await import(join(dist, 'plan', 'phase.js'));

const T1 = '2026-10-14T10:00:05.000Z';
const T0 = '2026-10-14T10:00:00.000Z';

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES ('p', ?, 'p', 'T2', '/r', 'main', 'spec_ready', 'registered', 'managed')`).run(T0);
  return db;
}
const tx = (db, fn) => transact(db, ENGINE_ACTOR, fn);
const run = (db, id, state, item) =>
  db
    .prepare(`INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined", "work_item") VALUES (?, ?, 'p', 1, 'verifier', 'one_shot', ?, 'scripted', '1', 'm', 'abc', ?, 0, ?)`)
    .run(id, T0, state, T1, item);
const work = (db, id, kind, status, subject, source = 'spec_obligation') =>
  db
    .prepare(`INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold") VALUES (?, ?, 'p', 1, ?, ?, ?, ?, 'scr_1', 1, 0, 0, 0, 0)`)
    .run(id, T0, kind, JSON.stringify(subject), status, source);
const obligation = (db, id, key, criteria, resolvedBy = null) =>
  db
    .prepare(`INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request", "resolved_by", "resolved_at") VALUES (?, ?, 'p', 'chk_x', ?, ?, 2, 'spec_changed', 'scr_1', ?, ?)`)
    .run(id, T0, key, JSON.stringify(criteria), resolvedBy, resolvedBy ? T0 : null);
const effective = (db, keys) => {
  db.prepare(`INSERT INTO "protected_versions" ("id", "created_at", "project", "seq", "fingerprint", "change_kind", "approved_by", "approver_authority", "approved_at", "authorized", "effective_from", "roots") VALUES ('pv_1', ?, 'p', 1, 'f', 'initial', 'human', 'human', ?, 1, ?, '[]')`).run(T0, T0, T0);
  for (const k of keys) db.prepare(`INSERT INTO "checks" ("id", "created_at", "project", "key", "protected_version", "kind", "required", "gate_kinds", "definition_path", "definition_hash", "runner_class") VALUES (?, ?, 'p', ?, 'pv_1', 'acceptance', 1, '[]', 'd', 'h', 'direct')`).run(`chk_${k}`, T0, k);
};
const open = (db) => db.prepare('SELECT "key" FROM "check_obligations" WHERE "resolved_at" IS NULL ORDER BY "key"').all().map((o) => o.key);

test('S1: an assessment resolves its obligation only in the transaction that records the run, never when that transaction fails', () => {
  const db = store();
  work(db, 'wi_c', 'check_correction', 'executing', { request: 'scr_1' });
  run(db, 'run_v', 'validating', 'wi_c');
  obligation(db, 'obl_i', 'integration', ['R2.2']);
  const assessments = { entries: [{ check: 'integration', criteria: ['R2.2'], rationale: 'status alone' }], rationales: ['rec_1'] };
  assert.throws(() =>
    tx(db, (t) => {
      recordRunReport(t, { run: 'run_v', assessments });
      throw new Error('a fault after the report');
    }),
  );
  assert.deepEqual(open(db), ['integration'], 'the failed attempt resolved nothing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "assessments"').get().n, 0, 'and recorded no assessment');
  tx(db, (t) => recordRunReport(t, { run: 'run_v', assessments }));
  assert.deepEqual(open(db), [], 'the retry resolves it');
  const a = db.prepare('SELECT * FROM "assessments"').get();
  assert.equal(db.prepare('SELECT "resolved_by" FROM "check_obligations"').get().resolved_by, a.id, 'by the assessment');
  assert.equal(a.provenance, 'claimed');
});

test('S2: a pending proposal whose impact cannot be computed is refused, its work ends and the slot frees', () => {
  const db = store();
  work(db, 'wi_s', 'spec_change', 'awaiting_decision', { request: 'scr_1' }, 'spec_change_request');
  db.prepare(`INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "request_text", "source", "status", "work_item", "proposal_revision", "proposal_blob", "side_ref") VALUES ('scr_1', ?, 'p', 1, 't', 'owner', 'proposed', 'wi_s', 'abc', 'b', 'refs/surety/spec-change/1')`).run(T0);
  const preview = tx(db, (t) => specChangeKind().preview(t, { project: 'p', kind: 'spec_change', subject_type: 'spec_change_request', subject_id: 'scr_1', scope: 'subject', options: '[]' }));
  assert.equal(preview, null, 'no question stands');
  const r = db.prepare('SELECT "status", "failure" FROM "spec_change_requests" WHERE "id" = \'scr_1\'').get();
  assert.equal(r.status, 'failed', 'the request is terminal');
  assert.match(r.failure, /spec_impact_uncomputable/, 'naming why');
  assert.equal(db.prepare('SELECT "status" FROM "work_items" WHERE "id" = \'wi_s\'').get().status, 'complete', 'its work ended');
});

test('S3: a correction completes only with every obligation of its request resolved; a partial one returns the rest to the Verifier; none resolved repairs', () => {
  const cases = [
    { what: 'all resolved', obligations: [['accept-r2', 'pv_2'], ['accept-r4', 'pv_2']], status: 'complete' },
    { what: 'one resolved', obligations: [['accept-r2', 'pv_2'], ['accept-r4', null]], status: 'eligible', repair: 0, open: ['accept-r4'] },
    { what: 'none resolved', obligations: [['accept-r2', null], ['accept-r4', null]], status: 'eligible', repair: 1 },
  ];
  for (const c of cases) {
    const db = store();
    work(db, 'wi_c', 'check_correction', 'executing', { request: 'scr_1' });
    db.prepare(`INSERT INTO "protected_proposals" ("id", "created_at", "project", "seq", "proposed_by", "base_revision", "tree_id", "diff_hash", "requested_change_kind", "status", "resulting_version") VALUES ('prop_1', ?, 'p', 1, 'verifier_run', 'b', 't', 'h', 'tightening', 'applied', 'pv_2')`).run(T0);
    c.obligations.forEach(([key, by], i) => obligation(db, `obl_${i}`, key, ['R2.1'], by));
    tx(db, (t) => correctionApplied(t, getWorkItem(t, 'wi_c'), { proposal: 'prop_1' }));
    const w = db.prepare('SELECT "status", "repair_due", "trigger_evidence" FROM "work_items" WHERE "id" = \'wi_c\'').get();
    assert.equal(w.status, c.status, `${c.what}: ${c.status}`);
    if (c.repair !== undefined) assert.equal(w.repair_due, c.repair, `${c.what}: repair due ${c.repair}`);
    if (c.open) assert.deepEqual(JSON.parse(w.trigger_evidence).open, c.open, `${c.what}: the open obligations listed`);
  }
});

test('M1: the current phase is the open plan\'s; a later-only change does not touch it; no phase counts as touching', () => {
  const db = store();
  const plan = (id, n, status, completed) =>
    db.prepare(`INSERT INTO "phase_plans" ("id", "created_at", "project", "phase_number", "prepared_against_revision", "git_path", "status", "active", "generation", "completed_at") VALUES (?, ?, 'p', ?, 'abc', 'x', ?, 1, 1, ?)`).run(id, T0, n, status, completed);
  plan('plan_1', 1, 'completed', T0);
  plan('plan_2', 2, 'published', null);
  assert.deepEqual(phasesTouched(db, 'p', [3]), { current: false, later: true, phase: 2 }, 'phase 3 only: later');
  assert.deepEqual(phasesTouched(db, 'p', [2]), { current: true, later: false, phase: 2 }, 'phase 2: current');
  assert.deepEqual(phasesTouched(db, 'p', [null]), { current: true, later: false, phase: 2 }, 'no phase: current');
  assert.deepEqual(phasesTouched(db, 'p', [1]), { current: false, later: false, phase: 2 }, 'phase 1, completed: neither');
});

test('M2: a result is after the loss of supervision by the store\'s order, whatever its finished_at', () => {
  const db = store();
  tx(db, (t) => {
    t.emit('check.result', { project: 'p', check_result: 'res_before' }, {});
    t.emit('check.result', { project: 'p', check_result: 'res_after' }, {});
  });
  const seqOf = (id) => db.prepare(`SELECT "seq" FROM "events" WHERE json_extract("subject", '$.check_result') = ?`).get(id).seq;
  const lostSeq = seqOf('res_before');
  // The clock stepped back: the later result's finished_at is earlier than the loss's time.
  assert.equal(resultAfterLoss(db, { result: 'res_before', finishedAt: T1, lostAt: T0, lostSeq }), false, 'recorded before the loss: evidence');
  assert.equal(resultAfterLoss(db, { result: 'res_after', finishedAt: T0, lostAt: T1, lostSeq }), true, 'recorded after: no evidence');
  assert.equal(resultAfterLoss(db, { result: 'res_none', finishedAt: T0, lostAt: T1, lostSeq }), true, 'no record of it: unknown, no evidence');
});

test('M3: a candidate holds a conformance stage when nominated after the stage\'s first event, by seq', () => {
  const db = store();
  tx(db, (t) => t.emit('candidate.nominated', { project: 'p', candidate: 'cand_1' }, {}));
  tx(db, (t) => t.emit('conformance.source_bound', { project: 'p', stage: 'st_c' }, {}));
  assert.equal(nominatedSince(db, 'p', 'st_c'), false, 'the only candidate came before the stage');
  tx(db, (t) => t.emit('candidate.nominated', { project: 'p', candidate: 'cand_2' }, {}));
  assert.equal(nominatedSince(db, 'p', 'st_c'), true, 'one nominated after it');
});

test('M4: the continuation canary reads turn 1 ended before turn 2 launched by insertion, though the clock stepped back', () => {
  const db = store();
  const turn = (n, inv) => db.prepare(`INSERT INTO "turns" ("id", "created_at", "project", "run", "number", "invocation", "domain", "started_at") VALUES (?, ?, 'p', 'run_s', ?, ?, ?, ?)`).run(`turn_${n}`, T0, n, inv, `dom_${n}`, T0);
  turn(1, 'inv_1');
  turn(2, 'inv_2');
  const obs = (id, inv, seq, status, at) => db.prepare(`INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at") VALUES (?, ?, 'p', ?, ?, ?, ?)`).run(id, at, inv, seq, status, at);
  obs('o1', 'inv_1', 1, 'launched', T0);
  obs('o2', 'inv_1', 2, 'ended', T1);
  obs('o3', 'inv_2', 1, 'launched', T0);
  const [t1, t2] = continuationFacts(db, { run: 'run_s' }).turns;
  assert.ok(t2.launched_at < t1.ended_at, 'the fixture is live: by wall time turn 2 launched first');
  assert.ok(t1.ended_order < t2.launched_order, 'by insertion turn 1 ended first');
});

test('N1: the Stop or Abandon applying to the work is the first confirmed by insertion, not by consumed_at', () => {
  const db = store();
  const dec = (id, kind, consumedAt, seq) =>
    db
      .prepare(
        `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "semantic_generation", "scope", "question", "options", "dependency_manifest", "transition_schema_version", "preview_hash", "evidence", "blocked_while_open", "raised_at", "status", "answer", "consumed_at")
         VALUES (?, ?, 'p', ?, ?, 'run', 'run_1', 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '[]', ?, 'consumed', '{"applied_to":"work"}', ?)`,
      )
      .run(id, T0, seq, kind, T0, consumedAt);
  dec('dec_1', 'stop_confirm', T1, 1);
  dec('dec_2', 'abandon_confirm', T0, 2);
  assert.equal(stopAfterExitOf(db, 'run_1').kind, 'stop_confirm');
});

test('N2: a finding raised after the plan\'s publication is the phase\'s, though its created_at is earlier', () => {
  const db = store();
  const finding = (id, seq, at) =>
    db
      .prepare(`INSERT INTO "findings" ("id", "created_at", "project", "seq", "scope", "subject_id", "category", "message", "proposed_severity", "effective_severity", "status") VALUES (?, ?, 'p', ?, 'project', 'p', 'defect', 'm', 'low', 'low', 'resolved')`)
      .run(id, at, seq);
  finding('fnd_before', 1, T1);
  tx(db, (t) => t.emit('finding.raised', { project: 'p', finding: 'fnd_before' }, {}));
  tx(db, (t) => t.emit('plan.published', { project: 'p', phase_plan: 'plan_1' }, {}));
  finding('fnd_after', 2, T0);
  tx(db, (t) => t.emit('finding.raised', { project: 'p', finding: 'fnd_after' }, {}));
  assert.deepEqual(findingsSincePublication(db, 'p', 'plan_1').map((f) => f.id), ['fnd_after']);
});

test('N3: an assessment naming a check the effective version does not have is outside it', () => {
  const db = store();
  effective(db, ['accept-r2']);
  work(db, 'wi_c', 'check_correction', 'executing', { request: 'scr_1' });
  run(db, 'run_v', 'validating', 'wi_c');
  obligation(db, 'obl_1', 'gone', ['R2.1']);
  const c = correctionFacts(db, { run: 'run_v', entries: [{ check: 'gone', criteria: ['R2.1'], rationale: 'r' }, { check: 'accept-r2', criteria: ['R2.1'], rationale: 'r' }] });
  assert.deepEqual(c.outside, ['gone']);
});
