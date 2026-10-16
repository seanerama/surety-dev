// Developer tests for the review an Alpha deployment's sign-off waits on
// (D3 §4.1; D4 §4.1; D6 §6.8; E150 item 3), found by real loop run 5: phase
// 2 completed on a candidate nominated by a phase verification's fix, after
// every stage was verified, so no stage gate ever queued its review; the
// owner's spec change (v2) and its check correction were applied; the
// `alpha_deploy: on_phase_complete` request evaluated `alpha_authorize`
// not satisfied with SIGNOFF_MISSING alone, recorded `not_issued` under its
// key, and nothing more happened. Now the engine asks its Reviewer, once per
// candidate and content; the request waits for the review and is made again
// when it ends, and the Reviewer's sign-off satisfies the gate. A Reviewer
// so asked who signs nothing parks the review behind the owner's blocker.
//
// Against a scratch store with the engine's migrations, foreign keys off;
// the gate is the production evaluateGate, reached through the production
// requestDeployment as the policy's tick does. No process, no git.

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
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { contentHash } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { requestDeployment, policyRequestDue, recordAdapterQualification } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T12:00:00.000Z';
const A = 'a'.repeat(40);
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };
// The checks of a T2 deployment scope: the kind inventory (D3 §4.3) and the
// completion's post-deploy behaviour check (J4).
const CHECKS = [
  ['acc', 'acceptance', '["R1.1"]', '["req_1"]', '["stage","alpha_authorize"]'],
  ['smoke', 'smoke', '[]', '[]', '["alpha_authorize"]'],
  ['integ', 'integration', '[]', '[]', '["alpha_authorize"]'],
  ['lint', 'security_lint', '[]', '[]', '["alpha_authorize"]'],
  ['behaves', 'post_deploy_behavior', '[]', '[]', '["alpha_complete"]'],
];

let seq = 100;

// A T2 project under `alpha_deploy: on_phase_complete`. Phase 1's one stage
// was verified on an earlier candidate; candidate 1 (a phase verification's
// fix) is the one the phase completed on: its verification and its phase
// verification are complete, and no review was ever queued for it. Then the
// owner's spec change (v2) and its correction: protected version 2, every
// check passed again under it. The Alpha environment is configured and its
// adapter qualified.
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
     VALUES ('prj_1', ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
     VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'blob', 'human', ?, '', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ alpha_deploy: 'on_phase_complete' }),
  );
  run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_1'`);
  for (const [id, version] of [['spec_1', 1], ['spec_2', 2]]) {
    run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES (?, ?, 'prj_1', ?, 'spec.md', 'b', 'd', 'human', ?)`, id, AT, version, AT);
  }
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES ('wi_1', ?, 'prj_1', 1, 'stage_build', '{"stage":"stage_1"}', 'complete', '[]', 'plan', 'stage_1', 1, 0, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'verified', 'wi_1', ?)`,
    AT,
    A,
  );
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'pv_1', 'developing', '[]')`,
  ).run(AT, A, AT);
  item(db, 'wi_v', 'verification', { candidate: 'cand_1' }, 'complete', { source: 'nomination', id: 'cand_1' });
  item(db, 'wi_pv', 'phase_verification', { candidate: 'cand_1', phase_plan: 'plan_1' }, 'complete', { source: 'phase', id: 'cand_1:plan_1' });
  for (const [id, ref, kind] of [['ref_main', 'refs/heads/main', 'integration'], ['ref_c1', 'refs/surety/cand/1', 'nomination']]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, A, kind === 'nomination' ? 1 : 0);
  }

  // Version 1, its checks passed on candidate 1, and the phase complete on it
  // (the phase Verifier's sign-off bound to spec v1).
  version(db, 'pv_1', 1, 'fp1');
  for (const [key] of CHECKS.slice(0, 4)) post(db, `chk_${key}_pv_1`);
  run(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at, completion_binding)
     VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1, 'completed', ?, ?)`,
    AT,
    A,
    AT,
    JSON.stringify({ candidate: 'cand_1', acceptance_hash: 'h1', protected_version: 'pv_1', spec_revision: 'spec_1', generation: 1, evaluation: 'gate_phase' }),
  );

  // The spec change and its correction: version 2 supersedes 1; every check
  // registered and passed again under it.
  run(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`);
  version(db, 'pv_2', 2, 'fp2');
  for (const [key] of CHECKS.slice(0, 4)) post(db, `chk_${key}_pv_2`);

  // Alpha: configured and qualified (D4 §§2.6, 3.2).
  run(
    `INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_config, current_generation, deployment_generation)
     VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'x', '{}', 'p', 'cfg_1', 1, 1)`,
    AT,
  );
  run(
    `INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at)
     VALUES ('cfg_1', ?, 'prj_1', 'env_1', 1, ?, 'ci_1', '[]', 'current', 'human', ?)`,
    AT,
    JSON.stringify({ adapter: 'local_service', adapter_version: '1', targets: ['web'], identity_method: 'http_identity' }),
    AT,
  );
  run(
    `INSERT INTO host_qualifications (id, created_at, host_id, kernel, tool_versions, mechanism_fingerprint, checks, probes, bootstrap_exception, evidence, status, incarnation, qualified_at)
     VALUES ('hq_1', ?, 'host', '6.6', '{"git":"2.43"}', 'mech', '[]', '[]', 0, 'rec_hq', 'active', 'inc_1', ?)`,
    AT,
    AT,
  );
  transact(db, ENGINE_ACTOR, (tx) => recordAdapterQualification(tx, { adapter: 'local_service', adapterVersion: '1', cases: [], label: { fixture: 'unit' } }));
  return db;
}

function version(db, id, n, fingerprint) {
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES (?, ?, 'prj_1', ?, ?, ?, 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
  ).run(id, AT, n, fingerprint, n === 1 ? 'initial' : 'tightening', AT, AT);
  for (const [key, kind, criteria, reqs, gates] of CHECKS) {
    db.prepare(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
       VALUES (?, ?, 'prj_1', ?, ?, ?, 1, ?, ?, 'h', 'direct', ?, ?, 'acceptance')`,
    ).run(`chk_${key}_${id}`, AT, key, id, kind, gates, `.surety/checks/defs/${key}.json`, criteria, reqs);
  }
}

function item(db, id, kind, subject, status, trigger) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
}

const post = (db, chk) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: 'cand_1', exit_status: 0 }, {}));

// The policy's request as its tick makes it (scheduler/tick.ts alphaPolicy):
// what policyRequestDue owes, through requestDeployment and evaluateGate.
const FACTS = {
  headFingerprint: 'fp2',
  head: A,
  refs: [
    { ref: 'refs/heads/main', read: 'value', oid: A },
    { ref: 'refs/surety/cand/1', read: 'value', oid: A },
  ],
};
const SEALED = { digest: 'sha256:' + 'd'.repeat(64), manifest: [], path: '/nowhere/artifact', bytes: 1, entries: 1, reused: 'new' };
const request = (db, requested_by = 'policy') =>
  transact(db, ENGINE_ACTOR, (tx) =>
    requestDeployment(tx, { project: 'prj_1', candidate: 'cand_1', environment: 'alpha', sealed: SEALED, specFingerprint: 's', builder: 'b', facts: FACTS, requested_by }, (tx2, a) => evaluateGate(tx2, a)),
  );
const reviews = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'review' AND json_extract(subject, '$.candidate') = 'cand_1' ORDER BY trigger_generation`).all();
const requests = (db) => db.prepare(`SELECT * FROM deployment_requests WHERE project = 'prj_1'`).all();
const latestAuthorize = (db) => db.prepare(`SELECT * FROM gate_evaluations WHERE gate_kind = 'alpha_authorize' ORDER BY rowid DESC LIMIT 1`).get();

// The Reviewer's run on the review, its report the given; recorded as a
// reporting run's end records it.
function reviewer(db, review, report) {
  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(review.id);
  const hash = contentHash(db, 'prj_1', db.prepare(`SELECT * FROM candidates WHERE id = 'cand_1'`).get());
  const id = `run_${review.id}`;
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value, content_hash)
     VALUES (?, ?, 'prj_1', ?, ?, 'reviewer', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, ?, ?)`,
  ).run(id, AT, ++seq, review.id, A, AT, JSON.stringify({ report }), hash);
  transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: id }));
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ? AND status = 'executing'`).run(review.id);
}

test('loop run 5: alpha_authorize refused SIGNOFF_MISSING alone on an unreviewed phase-complete candidate queues its review exactly once; the policy waits for it, asks again, and the sign-off satisfies the gate', (t) => {
  const db = store(t);
  assert.deepEqual(reviews(db), [], 'no review was ever queued for the candidate');
  const due = policyRequestDue(db, { project: 'prj_1' });
  assert.equal(due?.candidate, 'cand_1', 'the policy owes the request for the phase-complete candidate');

  const first = request(db);
  const refused = latestAuthorize(db);
  assert.equal(refused.outcome, 'not_satisfied');
  assert.deepEqual(JSON.parse(refused.reasons), [{ code: 'SIGNOFF_MISSING', subjects: ['cand_1'] }], 'every check passed, nothing else holds it: the sign-off alone');
  assert.equal(first.status, 409);
  assert.match(first.body.reason, /the policy requests it again/);
  assert.deepEqual(requests(db), [], 'no outcome under its key: the request is made again once the review has reported');

  const [review] = reviews(db);
  assert.ok(review, 'the engine queued the review the tier requires');
  assert.deepEqual([review.trigger_source, review.trigger_id, review.trigger_generation, review.status, review.chain], ['verification', 'cand_1', 1, 'eligible', 0]);
  const evidence = JSON.parse(review.trigger_evidence);
  assert.equal(evidence.gate, 'alpha_authorize');
  assert.equal(evidence.evaluation, refused.id);
  assert.equal(evidence.acceptance_content_hash, db.prepare('SELECT acceptance_content_hash AS h FROM acceptance_scopes WHERE id = ?').get(refused.scope).h, 'for the content the gate read');
  assert.deepEqual(evidence.signoffs, [{ role: 'reviewer', scope: 'candidate' }]);

  // While it is under way the policy requests nothing; asked anyway, the
  // request queues no second review.
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits for the review');
  request(db);
  assert.equal(reviews(db).length, 1, 'exactly once per candidate and content');
  assert.deepEqual(requests(db), []);

  reviewer(db, review, { signoffs: [{ scope: 'candidate' }] });
  assert.equal(reviews(db)[0].status, 'complete');
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the review has reported: the request is owed again');
  const issued = request(db);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(latestAuthorize(db).outcome, 'satisfied', 'the Reviewer\'s sign-off satisfies the gate');
  assert.equal(issued.body.authorization.status, 'issued');
  assert.ok(issued.body.work_item, 'deploy work is created');
  assert.deepEqual(requests(db).map((r) => [r.requested_by, r.outcome]), [['policy', 'pending']]);
  assert.equal(reviews(db).length, 1, 'still the one review');
});

test('a Reviewer asked for the Alpha sign-off who signs nothing and raises nothing parks the review behind the owner\'s blocker; the policy waits for the owner; a retry asks again', (t) => {
  const db = store(t);
  request(db);
  const [review] = reviews(db);
  reviewer(db, review, { signoffs: [] });
  const parked = db.prepare('SELECT * FROM work_items WHERE id = ?').get(review.id);
  assert.equal(parked.status, 'parked');
  assert.equal(JSON.parse(parked.blocker).reason, 'review_signoff_missing');
  const d = db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = ? AND status = 'open'`).get(review.id);
  assert.ok(d, 'the owner is asked');
  assert.match(d.question, /Alpha deployment/);
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits on the owner, recording nothing');
  assert.deepEqual(requests(db), []);
  const keys = JSON.parse(d.options).map((o) => o.key);
  assert.ok(keys.includes('retry'), `retry is offered (${keys})`);
  transact(db, HUMAN, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'retry', preview_hash: d.preview_hash, note: null }));
  assert.notEqual(db.prepare('SELECT status FROM work_items WHERE id = ?').get(review.id).status, 'parked', 'retried: the review is asked again');
  assert.equal(reviews(db).length, 1, 'the same review, no new one');
});

test("the owner's own request refused on the sign-off alone queues the review and says so; the request is recorded not_issued as before", (t) => {
  const db = store(t);
  const refused = request(db, 'human');
  assert.equal(refused.status, 409);
  assert.match(refused.body.what_to_do, /review.*is queued/);
  assert.equal(reviews(db).length, 1);
  assert.deepEqual(requests(db).map((r) => [r.requested_by, r.outcome]), [['human', 'not_issued']]);
});
