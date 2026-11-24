// The scratch store the developer tests of DECISIONS items 43 and 44 share
// (ask-verifier-for-check.test.mjs, waiting-for-reviewer-signoff.test.mjs):
// a T2 Node service, its build complete, on the engine's migrations with
// foreign keys off (as alpha-gap-authoring.test.mjs and
// serving-check-visibility.test.mjs); the route's transaction and the reads.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
export const { migrate } = await import(join(dist, 'store', 'migrate.js'));
export const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
export const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
export const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));
export const { requestDeployment, recordAdapterQualification } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
export const { requestEnvironmentChecks } = await import(join(dist, 'store', 'transitions', 'request-checks.js'));
export const { nextExecutionSeq } = await import(join(dist, 'store', 'transitions', 'checks.js'));
export const { readProject } = await import(join(dist, 'store', 'projections.js'));
const { recordCompatibility } = await import(join(dist, 'deploy', 'compatibility.js'));
const { readTreeKind } = await import(join(dist, 'deploy', 'output-kind.js'));
export const { roleModelOf } = await import(join(dist, 'prototype', 'brief.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: mkdtempSync(join(tmpdir(), 'surety-avb-git-')), incarnation: 'inc_test' });

export const AT = '2026-11-24T00:00:00.000Z';
const HEX = 'a'.repeat(64);
export const OWNER = { actor_kind: 'human', actor_id: 'owner', request_id: null };

// A T2 deployment scope's checks (the kind inventory, D3 §4.3), and no
// post-deploy behaviour check (J4): no authoring wrote one.
export const CHECKS = [
  ['acc', 'acceptance', '["R1.1"]', '["req_1"]', '["stage","alpha_authorize"]'],
  ['smoke', 'smoke', '[]', '[]', '["alpha_authorize"]'],
  ['integ', 'integration', '[]', '[]', '["alpha_authorize"]'],
  ['lint', 'security_lint', '[]', '[]', '["alpha_authorize"]'],
];
export const BEHAVES = ['behaves', 'post_deploy_behavior', '[]', '[]', '["alpha_complete"]'];
const NODE_MAP = {
  version: 1,
  modules: [{ name: 'api', paths: ['server.mjs'], sensitive_areas: [], interfaces: [{ name: 'notes', kind: 'http', path: '/notes', description: 'the notes' }], surface: 'api' }],
  mapping_from_spec: [],
};
const SPEC = {
  header: { spec_version: 1, status: 'approved', tier: 'T2', owner: 'o' },
  requirements: [],
  index: [],
  questions: [],
  modules: [],
  claims: [],
  environments: [{ name: 'alpha', fields: { Purpose: 'Alpha', 'Runtime and start command': '`node server.mjs`' } }],
  targets: ['web'],
};
const SERVICE = { adapter: 'local_service', adapter_version: '1', targets: ['web'], runtime: { path: '/usr/bin/node', sha256: HEX }, start: ['node', 'server.mjs'], port: 8080, identity_method: 'http_identity' };

let seq = 100;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// A T2 Node service, its build complete (one roadmap phase, its plan
// completed on candidate 1), every check of protected version 1 passed on
// the candidate, no behavioural check; environment alpha configured as a
// local service and its adapter qualified; beta configured in static mode
// (which cannot host a Node service). `policy`: alpha_deploy.
export async function store(t, { policy = 'manual', behaves = false, effective = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-avb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  execFileSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }));
  writeFileSync(join(repo, 'server.mjs'), '');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'c');
  const A = git(repo, 'rev-parse', 'HEAD');
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T2', ?, 'main', 'spec_ready', 'registered', '{}')`,
    AT,
    repo,
  );
  run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective) VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'blob', 'human', ?, '', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ alpha_deploy: policy, ...effective }),
  );
  run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_1'`);
  run(`INSERT INTO spec_semantics (id, created_at, project, git_blob, representation, readable) VALUES ('ss_1', ?, 'prj_1', 'b', ?, 1)`, AT, JSON.stringify(SPEC));
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, semantics, approved_by, approved_at) VALUES ('spec_1', ?, 'prj_1', 1, 'spec.md', 'b', 'd', 'ss_1', 'human', ?)`, AT, AT);
  run(`INSERT INTO architecture_revisions (id, created_at, project, version, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('ar_1', ?, 'prj_1', 1, '{}', ?, '[]', 'human', ?)`, AT, JSON.stringify(NODE_MAP), AT);
  run(`INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_1', ?, 'prj_1', 1, 'r', 'b', ?, 'human', ?)`, AT, JSON.stringify([{ number: 1 }]), AT);
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  item(db, 'wi_1', 'stage_build', { stage: 'stage_1' }, 'complete', { source: 'plan', id: 'stage_1' });
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision) VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'verified', 'wi_1', ?)`,
    AT,
    A,
  );
  run(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'pv_1', 'developing', '[]')`,
    AT,
    A,
    AT,
  );
  item(db, 'wi_v', 'verification', { candidate: 'cand_1' }, 'complete', { source: 'nomination', id: 'cand_1' });
  for (const [id, ref, kind] of [['ref_main', 'refs/heads/main', 'integration'], ['ref_c1', 'refs/surety/cand/1', 'nomination']]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, A, kind === 'nomination' ? 1 : 0);
  }
  version(db, 'pv_1', 1, 'fp1', behaves ? [...CHECKS, BEHAVES] : CHECKS);
  for (const [key] of CHECKS) post(db, `chk_${key}_pv_1`);
  run(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at, completion_binding) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1, 'completed', ?, ?)`,
    AT,
    A,
    AT,
    JSON.stringify({ candidate: 'cand_1', acceptance_hash: 'h1', protected_version: 'pv_1', spec_revision: 'spec_1', generation: 1, evaluation: 'gate_phase' }),
  );
  env(db, 'env_1', 'alpha', 'cfg_1', SERVICE);
  env(db, 'env_2', 'beta', 'cfg_2', { adapter: 'local_service', adapter_version: '1', targets: ['web'], mode: 'static', static: { root: '.', entry: 'index.html' }, port: 8081 });
  run(
    `INSERT INTO host_qualifications (id, created_at, host_id, kernel, tool_versions, mechanism_fingerprint, checks, probes, bootstrap_exception, evidence, status, incarnation, qualified_at) VALUES ('hq_1', ?, 'host', '6.6', '{"git":"2.43"}', 'mech', '[]', '[]', 0, 'rec_hq', 'active', 'inc_1', ?)`,
    AT,
    AT,
  );
  transact(db, ENGINE_ACTOR, (tx) => recordAdapterQualification(tx, { adapter: 'local_service', adapterVersion: '1', cases: [], label: { fixture: 'unit' } }));
  const tree = await readTreeKind(repo, A);
  transact(db, ENGINE_ACTOR, (tx) => recordCompatibility(tx, { project: 'prj_1', trigger: 'candidate_nominated', tree }));
  const facts = {
    headFingerprint: 'fp1',
    head: A,
    refs: [
      { ref: 'refs/heads/main', read: 'value', oid: A },
      { ref: 'refs/surety/cand/1', read: 'value', oid: A },
    ],
  };
  return { db, tree, facts };
}

export function env(db, id, name, cfg, content) {
  db.prepare(
    `INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_config, current_generation, deployment_generation) VALUES (?, ?, 'prj_1', ?, 'local_service', 'x', '{}', ?, ?, 1, 1)`,
  ).run(id, AT, name, `p${id}`, cfg);
  db.prepare(
    `INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES (?, ?, 'prj_1', ?, 1, ?, ?, '[]', 'current', 'human', ?)`,
  ).run(cfg, AT, id, JSON.stringify(content), `ci_${cfg}`, AT);
}

export function version(db, id, n, fingerprint, checks) {
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme, proposal) VALUES (?, ?, 'prj_1', ?, ?, ?, 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest', NULL)`,
  ).run(id, AT, n, fingerprint, n === 1 ? 'initial' : 'tightening', AT, AT);
  for (const [key, kind, criteria, reqs, gates] of checks) {
    db.prepare(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin) VALUES (?, ?, 'prj_1', ?, ?, ?, 1, ?, ?, 'h', 'direct', ?, ?, 'acceptance')`,
    ).run(`chk_${key}_${id}`, AT, key, id, kind, gates, `.surety/checks/defs/${key}.json`, criteria, reqs);
  }
}

export function item(db, id, kind, subject, status, trigger) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain) VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
}

export const post = (db, chk, version) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: 'cand_1', exit_status: 0, ...(version ? { protected_version: version } : {}) }, {}));

// The route's transaction as the API's `environment.request_checks` runs it.
export const ask = (fx, environment = 'alpha', over = {}) => {
  try {
    return transact(fx.db, OWNER, (tx) => requestEnvironmentChecks(tx, { project: 'prj_1', environment, candidate: 'cand_1', facts: fx.facts, trees: [fx.tree], ...over }));
  } catch (err) {
    if (err && typeof err.status === 'number') return { status: err.status, body: { code: err.code, reason: err.reason, what_to_do: err.whatToDo ?? err.what_to_do, subject: err.subject } };
    throw err;
  }
};
export const readiness = (fx) => readProject(fx.db, { project: 'prj_1', trees: [fx.tree] }).project.build.deploy_readiness;
export const authorings = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'check_authoring' ORDER BY rowid`).all();
export const authorizeEvaluations = (db) => db.prepare(`SELECT * FROM gate_evaluations WHERE gate_kind = 'alpha_authorize' ORDER BY rowid`).all();
export const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
export const decide = (db, id, subject, status = 'open') =>
  db
    .prepare(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status) VALUES (?, ?, 'prj_1', 1, 'check_correction_tightening', 'protected_proposal', ?, 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, ?)`,
    )
    .run(id, AT, subject, AT, status);
export const runFor = (db, id, workItem, state, role = 'verifier') =>
  db
    .prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES (?, ?, 'prj_1', ?, ?, ?, 'one_shot', ?, 'scripted', '1', 'm', 'r', ?, 0)`,
    )
    .run(id, AT, ++seq, workItem, role, state, AT);
export const proposalOf = (db, id, run, status) =>
  db
    .prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES (?, ?, 'prj_1', ?, 'verifier_run', ?, 'b', 't', 'd', 'tightening', ?)`)
    .run(id, AT, ++seq, run, status);

