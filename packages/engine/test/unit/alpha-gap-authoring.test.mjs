// Developer tests for the checks an Alpha deployment's gate lacks, asked of
// the Verifier (D4 §4.1 J4, §5.1; D6 §6.2, §6.8), found by real visual run
// 2: phases 1 and 2's check authoring wrote no `post_deploy_behavior` check;
// at phase 2's completion the `alpha_deploy: on_phase_complete` request
// evaluated `alpha_authorize` not satisfied with ACCEPTANCE_SCOPE_INCOMPLETE
// `kind:post_deploy_behavior` alone, recorded `not_issued` under its key, and
// nothing more happened. Now the engine registers a check_authoring on the
// `authoring_gap` route, once per gap and plan, its package naming the gate,
// the environment and its target's variable; the policy waits for it and
// requests again once it ends; the applied check removes the gate's kind
// reason.
//
// Against a scratch store with the engine's migrations, foreign keys off
// (alpha-signoff-review.test.mjs's fixture, less the behaviour check); the
// gate is the production evaluateGate, reached through the production
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
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { requestDeployment, policyRequestDue, recordAdapterQualification } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { contentHash } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { nextExecutionSeq } = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { phaseAuthoringText } = await import(join(dist, 'checks', 'guide.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T12:00:00.000Z';
const A = 'a'.repeat(40);
// The checks of a T2 deployment scope: the kind inventory (D3 §4.3), and no
// post-deploy behaviour check (J4): no authoring wrote one.
const CHECKS = [
  ['acc', 'acceptance', '["R1.1"]', '["req_1"]', '["stage","alpha_authorize"]'],
  ['smoke', 'smoke', '[]', '[]', '["alpha_authorize"]'],
  ['integ', 'integration', '[]', '[]', '["alpha_authorize"]'],
  ['lint', 'security_lint', '[]', '[]', '["alpha_authorize"]'],
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

function version(db, id, n, fingerprint, checks = CHECKS) {
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES (?, ?, 'prj_1', ?, ?, ?, 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
  ).run(id, AT, n, fingerprint, n === 1 ? 'initial' : 'tightening', AT, AT);
  for (const [key, kind, criteria, reqs, gates] of checks) {
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

const authorings = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'check_authoring' ORDER BY trigger_generation`).all();
const kindReason = (ev) => JSON.parse(ev.reasons).find((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE');

// The authoring's proposal applied: version 3, with the behaviour check,
// supersedes 2; the workspace checks registered and passed again under it;
// the authoring's item complete.
function applyBehaviour(db, authoring) {
  db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_3' WHERE id = 'pv_2'`).run();
  version(db, 'pv_3', 3, 'fp3', [...CHECKS, ['behaves', 'post_deploy_behavior', '[]', '[]', '["alpha_complete"]']]);
  for (const [key] of CHECKS) post(db, `chk_${key}_pv_3`);
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(authoring.id);
}

const FACTS3 = { ...FACTS, headFingerprint: 'fp3' };
const request3 = (db) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    requestDeployment(tx, { project: 'prj_1', candidate: 'cand_1', environment: 'alpha', sealed: SEALED, specFingerprint: 's', builder: 'b', facts: FACTS3, requested_by: 'policy' }, (tx2, a) => evaluateGate(tx2, a)),
  );

test('visual run 2: alpha_authorize refused on kind:post_deploy_behavior registers one authoring_gap check_authoring; the policy waits, asks again once the check is applied, and the kind reason is gone', (t) => {
  const db = store(t);
  const due = policyRequestDue(db, { project: 'prj_1' });
  assert.equal(due?.candidate, 'cand_1');

  const first = request(db);
  const refused = latestAuthorize(db);
  assert.equal(refused.outcome, 'not_satisfied');
  assert.deepEqual(kindReason(refused), { code: 'ACCEPTANCE_SCOPE_INCOMPLETE', subjects: ['kind:post_deploy_behavior'] }, "no applied check is the completion's behaviour check (J4)");
  assert.equal(first.status, 409);
  assert.match(first.body.reason, /the policy requests it again/);
  assert.deepEqual(requests(db), [], 'no outcome under its key while the check is authored');
  assert.deepEqual(reviews(db), [], 'no review asked for content the authoring will change');

  const [authoring] = authorings(db);
  assert.ok(authoring, 'a check_authoring is registered for the gap');
  assert.deepEqual([authoring.trigger_source, authoring.trigger_id, authoring.trigger_generation, authoring.status, authoring.chain], ['authoring_gap', 'plan_1', 1, 'eligible', 0]);
  assert.deepEqual(JSON.parse(authoring.subject), { phase_plan: 'plan_1' });
  const { deployment } = JSON.parse(authoring.trigger_evidence);
  assert.equal(deployment.gate, 'alpha_authorize');
  assert.equal(deployment.evaluation, refused.id);
  assert.equal(deployment.environment, 'alpha');
  assert.deepEqual(deployment.targets, [{ name: 'web', variable: 'SURETY_TARGET_WEB' }]);
  assert.deepEqual(deployment.missing, { kinds: ['post_deploy_behavior'], criteria: [], areas: [] });

  // Its package says which kind is missing, at which gate, for which
  // environment, and the target's variable.
  const text = phaseAuthoringText({ phase_plan: { id: 'plan_1', phase_number: 1, generation: 1 }, stages: [], interfaces: [], architecture: '', environments: [], follow_up: null, deployment }).join('\n');
  assert.match(text, /Alpha deployment of candidate cand_1 to environment `alpha`/);
  assert.match(text, /`alpha_authorize`, evaluation /);
  assert.match(text, /`post_deploy_behavior` for environment `alpha`/);
  assert.match(text, /`SURETY_TARGET_WEB` \(target `web`\)/);
  assert.match(text, /`requires` \[`environment`, `artifact_digest`\]/);

  // While it is under way the policy requests nothing; asked anyway, no
  // second authoring.
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits for the authoring');
  request(db);
  assert.equal(authorings(db).length, 1, 'exactly once per gap and plan');
  assert.deepEqual(requests(db), []);

  applyBehaviour(db, authoring);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the authoring has ended: the request is owed again');
  const again = request3(db);
  const after = latestAuthorize(db);
  assert.equal(kindReason(after), undefined, `the applied check gives the scope its kind: ${after.reasons}`);
  assert.deepEqual(JSON.parse(after.reasons), [{ code: 'SIGNOFF_MISSING', subjects: ['cand_1'] }], 'the sign-off on the new content is what remains');
  assert.equal(again.status, 409);
  assert.equal(reviews(db).length, 1, 'whose review is now asked (alpha-review.ts)');
  assert.equal(authorings(db).length, 1, 'no second authoring');
});

test('a gap the authoring left as it was is not asked again: the request is recorded not_issued and the key stands', (t) => {
  const db = store(t);
  request(db);
  const [authoring] = authorings(db);
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(authoring.id);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1');
  const refused = request(db);
  assert.equal(refused.status, 409);
  assert.deepEqual(requests(db).map((r) => [r.requested_by, r.outcome]), [['policy', 'not_issued']]);
  assert.equal(authorings(db).length, 1, 'once per gap and plan');
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the key is not made again');
});

test("a policy request recorded not_issued on the gap before this route (visual run 2's store) is made again: the authoring is asked once, and the request once after it", (t) => {
  const db = store(t);
  const due = policyRequestDue(db, { project: 'prj_1' });
  request(db);
  // As the store stood: no authoring asked, the key's request not_issued.
  db.prepare(`DELETE FROM work_items WHERE kind = 'check_authoring'`).run();
  const auth = db.prepare('SELECT id FROM deployment_authorizations').get();
  db.prepare(
    `INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, work_item, outcome, reason) VALUES ('dreq_1', ?, 'prj_1', ?, 'policy', 'cand_1', 'env_1', ?, NULL, 'not_issued', NULL)`,
  ).run(AT, due.key, auth.id);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the gap was never asked for: the key is made again');
  request(db);
  const [authoring] = authorings(db);
  assert.ok(authoring, 'the authoring is asked');
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits for it');
  applyBehaviour(db, authoring);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'made again once after it');
  request3(db);
  assert.equal(kindReason(latestAuthorize(db)), undefined);
  assert.equal(authorings(db).length, 1);
});

test("the owner's request refused on the gap queues the authoring and says so; a phase's package states the behaviour check while none is applied", (t) => {
  const db = store(t);
  const refused = request(db, 'human');
  assert.equal(refused.status, 409);
  assert.match(refused.body.what_to_do, /being authored/);
  assert.equal(authorings(db).length, 1);
  const base = { phase_plan: { id: 'plan_1', phase_number: 1, generation: 1 }, stages: [], interfaces: [], architecture: '', environments: [], follow_up: null };
  assert.match(phaseAuthoringText({ ...base, behavior_check: false }).join('\n'), /### The deployment's check[\s\S]*No required `post_deploy_behavior` check is applied yet/);
  assert.match(phaseAuthoringText({ ...base, phase_plan: { ...base.phase_plan, phase_number: 2 }, behavior_check: false }).join('\n'), /### The deployment's check/, 'a later phase while none is applied');
  assert.doesNotMatch(phaseAuthoringText({ ...base, phase_plan: { ...base.phase_plan, phase_number: 2 }, behavior_check: true }).join('\n'), /### The deployment's check/);
});

// ---- the request made again after the gap's authoring (real visual run 2,
// second stall): the applied version's checks registered on the candidate,
// queued, when the policy asks again.

// The authoring's proposal applied as protected_application registers it:
// version 3 (the behaviour check, and `extra`, a check of a key no version
// had before) supersedes 2, the earlier results invalidated
// (`protected_version_superseded`), every workspace check of version 3
// registered on the candidate and queued.
function applyQueued(db, authoring) {
  db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_3' WHERE id = 'pv_2'`).run();
  const added = [...CHECKS, ['extra', 'integration', '[]', '[]', '["alpha_authorize"]'], ['behaves', 'post_deploy_behavior', '[]', '[]', '["alpha_complete"]']];
  version(db, 'pv_3', 3, 'fp3', added);
  db.prepare(`UPDATE check_results SET invalidated_at = ?, invalidated_reason = 'protected_version_superseded' WHERE invalidated_at IS NULL`).run(new Date().toISOString());
  const executions = [];
  transact(db, ENGINE_ACTOR, (tx) => {
    for (const [key] of added.slice(0, 5)) {
      const id = `cx_${key}`;
      tx.db
        .prepare(
          `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
           VALUES (?, ?, 'prj_1', ?, ?, 'cand_1', ?, 'pv_3', 'direct', ?, ?, ?, 'queued', ?)`,
        )
        .run(id, tx.at, `chk_${key}_pv_3`, key, A, nextExecutionSeq(tx, 'prj_1'), JSON.stringify({ source: 'protected_application', id: 'prop_1', generation: 1 }), `pa:${key}`, tx.at);
      executions.push({ id, check: `chk_${key}_pv_3` });
    }
  });
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(authoring.id);
  return executions;
}

// The executions end: each result recorded, the execution `recorded`.
function runQueued(db, executions, exit_status = 0) {
  for (const x of executions) {
    const { check_result } = post3(db, x.check, exit_status);
    db.prepare(`UPDATE check_executions SET status = 'recorded', result = ?, finished_at = ? WHERE id = ?`).run(check_result.id, new Date().toISOString(), x.id);
  }
}
const post3 = (db, chk, exit_status) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: 'cand_1', exit_status, protected_version: 'pv_3' }, {}));

// The Reviewer's run on the review, signing what it was asked for.
function reviewerSigns(db, review) {
  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(review.id);
  const hash = contentHash(db, 'prj_1', db.prepare(`SELECT * FROM candidates WHERE id = 'cand_1'`).get());
  const id = `run_${review.id}`;
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value, content_hash)
     VALUES (?, ?, 'prj_1', ?, ?, 'reviewer', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, ?, ?)`,
  ).run(id, AT, ++seq, review.id, A, AT, JSON.stringify({ report: { signoffs: [{ scope: 'candidate' }] } }), hash);
  transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: id }));
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ? AND status = 'executing'`).run(review.id);
}

// The key's request recorded not_issued on the gap before the route existed
// (visual run 2's dreq_01M532QT...), the route then taken.
function gapRowThenAuthoring(db) {
  const due = policyRequestDue(db, { project: 'prj_1' });
  request(db);
  db.prepare(`DELETE FROM work_items WHERE kind = 'check_authoring'`).run();
  const auth = db.prepare('SELECT id FROM deployment_authorizations').get();
  db.prepare(
    `INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, work_item, outcome, reason) VALUES ('dreq_1', ?, 'prj_1', ?, 'policy', 'cand_1', 'env_1', ?, NULL, 'not_issued', NULL)`,
  ).run(AT, due.key, auth.id);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1');
  request(db);
  const [authoring] = authorings(db);
  assert.ok(authoring);
  return authoring;
}

test("visual run 2's second stall: the request made again after the authoring evaluates the new version's checks queued with SIGNOFF_MISSING; it records nothing, waits for them, is made again, queues the review, and is issued on the sign-off", (t) => {
  const db = store(t);
  const authoring = gapRowThenAuthoring(db);
  const executions = applyQueued(db, authoring);

  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the authoring has ended: made again once after it');
  const waiting = request3(db);
  const ev = latestAuthorize(db);
  const reasons = JSON.parse(ev.reasons);
  assert.deepEqual(
    reasons.map((r) => r.code),
    ['CHECK_NOT_PASSED', 'SIGNOFF_MISSING'],
    `the new version's checks have not run on the candidate: ${ev.reasons}`,
  );
  assert.ok(reasons[0].subjects.includes('chk_extra_pv_3'), 'a check of a key no earlier version had is among them');
  assert.equal(waiting.status, 409);
  assert.match(waiting.body.reason, /the policy requests it again/, 'settling: no outcome recorded');
  assert.deepEqual(requests(db).map((r) => [r.id, r.outcome]), [['dreq_1', 'not_issued']], 'the row is as it was');
  assert.deepEqual(reviews(db), [], 'no review while the checks are still to run');

  // While they are queued the policy requests nothing (each request seals an
  // artifact).
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits for the checks');

  runQueued(db, executions);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the checks have run: the request is made again');
  const signoff = request3(db);
  assert.deepEqual(JSON.parse(latestAuthorize(db).reasons), [{ code: 'SIGNOFF_MISSING', subjects: ['cand_1'] }], 'the sign-off on the new content alone');
  assert.equal(signoff.status, 409);
  assert.match(signoff.body.reason, /the policy requests it again/);
  const [review] = reviews(db);
  assert.ok(review, 'the review is queued (alpha-review.ts)');
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the policy waits for the review');

  reviewerSigns(db, review);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'signed: the request is made again');
  const issued = request3(db);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(latestAuthorize(db).outcome, 'satisfied');
  assert.equal(issued.body.authorization.status, 'issued');
  assert.ok(issued.body.work_item, 'deploy work is created');
  assert.deepEqual(requests(db).map((r) => [r.id, r.requested_by, r.outcome]), [['dreq_1', 'policy', 'pending']], "the key's one row, its outcome now the deployment's");
  assert.equal(reviews(db).length, 1);
  assert.equal(authorings(db).length, 1);
});

test("a row recorded not_issued on that wait (visual run 2's store at the stall) is made again once; a queued check that then fails records not_issued and the key stands", async (t) => {
  const db = store(t);
  const authoring = gapRowThenAuthoring(db);
  const executions = applyQueued(db, authoring);
  request3(db);
  const waited = latestAuthorize(db);
  assert.deepEqual(JSON.parse(waited.reasons).map((r) => r.code), ['CHECK_NOT_PASSED', 'SIGNOFF_MISSING']);
  // The store as visual run 2 stalled: the key's row the not_issued of the
  // gap's refusal, the newer evaluation recorded nowhere.
  assert.deepEqual(requests(db).map((r) => r.outcome), ['not_issued']);

  // The checks end, one of them failed.
  runQueued(db, executions.slice(0, 1), 1);
  runQueued(db, executions.slice(1));
  // The next evaluation is a later millisecond than the results (as a tick's is).
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1', 'the refusal only waited: made again once');
  const refused = request3(db);
  assert.equal(refused.status, 409);
  const after = JSON.parse(latestAuthorize(db).reasons);
  assert.deepEqual(after.find((r) => r.code === 'CHECK_NOT_PASSED')?.subjects, [executions[0].check], 'the failed check');
  assert.match(refused.body.reason, /is not authorized: alpha_authorize is not satisfied/, 'a failed result is lasting: recorded');
  assert.deepEqual(requests(db).map((r) => r.outcome), ['not_issued']);
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'the key stands: no loop');
  assert.deepEqual(reviews(db), [], 'no review for a candidate a failed check refuses');
});

test('a fresh policy request whose gate names checks of a new key still queued on the candidate records no outcome (it is not taken as lasting)', (t) => {
  const db = store(t);
  request(db);
  const [authoring] = authorings(db);
  const executions = applyQueued(db, authoring);
  const waiting = request3(db);
  assert.equal(waiting.status, 409);
  assert.match(waiting.body.reason, /the policy requests it again/);
  assert.deepEqual(requests(db), [], 'no outcome under its key');
  assert.equal(policyRequestDue(db, { project: 'prj_1' }), null, 'waits while they are queued');
  runQueued(db, executions);
  assert.equal(policyRequestDue(db, { project: 'prj_1' })?.candidate, 'cand_1');
});
