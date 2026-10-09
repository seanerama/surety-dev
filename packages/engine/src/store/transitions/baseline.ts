// Baseline inputs and observations that enter M1 as labelled test setup
// (build spec §3; Plan §§1, 2; SEAM.md §67): the approved spec's
// requirements and modules, the checks D3 would discover in the protected
// set, recorded executions of a check, a configured test target, a
// validation-scope approval, the evidence of an Alpha exception and a reuse
// entry. Each is a transition: the harness reaches the store only through
// these, and labels what it causes. M1 has no check runner, no classifier
// and no reuse assessment; nothing here qualifies one.

import { Refusal } from '../../refusal.js';
import { canonical, notFound, sha256 } from './common.js';
import { getCandidate, markStale } from './evidence.js';
import { getProposal, mustEffective } from './protected.js';
import type { Tx } from './tx.js';
import { knownCriteria, nextExecutionSeq, recomputeIndexErrors } from './checks.js';
import { requirementKeyOf } from '../../checks/schema.js';
import { reconcileRepairs } from './repair.js';

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });

const project = (tx: Tx, id: string) => {
  const row = tx.db.prepare('SELECT "id", "tier" FROM "projects" WHERE "id" = ?').get(id) as { id: string; tier: string } | undefined;
  if (!row) throw notFound('project', id);
  return row;
};

// Requirements of the approved spec, by key: created once, returned after.
// A requirement's approved text, when one is given, is kept with it: the
// context package carries it (E67 item 7).
export function ensureRequirements(tx: Tx, args: { project: string; keys: string[]; texts?: Record<string, string> }): { id: string; key: string }[] {
  project(tx, args.project);
  const out: { id: string; key: string }[] = [];
  for (const key of args.keys) {
    const text = args.texts?.[key] ?? null;
    const row = tx.db.prepare('SELECT "id", "text" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(args.project, key) as { id: string; text: string | null } | undefined;
    if (row) {
      if (text !== null && row.text === null) tx.db.prepare('UPDATE "requirements" SET "text" = ? WHERE "id" = ?').run(text, row.id);
      out.push({ id: row.id, key });
      continue;
    }
    const id = tx.newId('req_');
    tx.db
      .prepare(`INSERT INTO "requirements" ("id", "created_at", "project", "key", "text_ref", "status", "text") VALUES (?, ?, ?, ?, ?, 'approved', ?)`)
      .run(id, tx.at, args.project, key, `spec#${key}`, text);
    out.push({ id, key });
  }
  return out;
}

// The approved baseline's ADRs and project-wide constraints (F §3.10.8), by
// key with their texts: created once; the id is what the engine names each
// by (the manifest's `source`).
export function ensureBaselineTexts(tx: Tx, args: { project: string; kind: 'adr' | 'constraint'; items: { key: string; text: string }[] }): { key: string; source: string }[] {
  project(tx, args.project);
  return args.items.map((item) => {
    const row = tx.db.prepare('SELECT "id" FROM "baseline_texts" WHERE "project" = ? AND "kind" = ? AND "key" = ?').get(args.project, args.kind, item.key) as { id: string } | undefined;
    if (row) return { key: item.key, source: row.id };
    const id = tx.newId(args.kind === 'adr' ? 'adr_' : 'con_');
    tx.db.prepare('INSERT INTO "baseline_texts" ("id", "created_at", "project", "kind", "key", "text") VALUES (?, ?, ?, ?, ?, ?)').run(id, tx.at, args.project, args.kind, item.key, item.text);
    return { key: item.key, source: id };
  });
}

// The identity of a project's approved spec as M1 holds it (build spec §3:
// the baseline is a fixture; there is no spec revision row): a hash over its
// requirements, each by key with its text reference, phase and status. What
// a protected correction's preview binds as `spec_revision` (D1 A.8; Review
// B12 "approved spec"; row M53): a requirement added, removed or changed
// between the preview and the answer is a changed dependency.
//
// The binding covers the requirement index too, each requirement's criteria
// and sensitive areas (D3 §§3.3, 4.5; T10; SEAM.md §218): a spec revision
// that changes only those is a changed dependency as well.
export function specRevision(db: Tx['db'], projectId: string): string {
  const rows = db
    .prepare('SELECT "key", "text_ref", "assigned_phase", "status", "criteria", "sensitive_areas" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
    .all(projectId) as { key: string; text_ref: string; assigned_phase: number | null; status: string; criteria: string | null; sensitive_areas: string }[];
  return sha256(
    canonical(
      rows.map((r) => [r.key, r.text_ref, r.assigned_phase, r.status, r.criteria === null ? null : (JSON.parse(r.criteria) as unknown), JSON.parse(r.sensitive_areas) as unknown]),
    ),
  );
}

export function requirementIds(tx: Tx, projectId: string, keys: string[], field: string): string[] {
  return keys.map((key) => {
    const row = tx.db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(projectId, key) as { id: string } | undefined;
    if (!row) throw invalid(field, `names the requirement "${key}", which the approved spec does not have`);
    return row.id;
  });
}

// The requirement index's fields (D3 §4.5, A.3), each row's requirement
// created if the spec had none, then the versions' errors recomputed against
// the index (SEAM.md §179).
export function registerRequirementIndex(
  tx: Tx,
  args: { project: string; rows: { key: string; phase: number | null; sensitive_areas: string[]; criteria: string[] }[] },
): { id: string; key: string; criteria: string[]; sensitive_areas: string[] }[] {
  const made = ensureRequirements(tx, { project: args.project, keys: args.rows.map((r) => r.key) });
  const out: { id: string; key: string; criteria: string[]; sensitive_areas: string[] }[] = [];
  for (const r of args.rows) {
    const id = made.find((m) => m.key === r.key)!.id;
    tx.db
      .prepare('UPDATE "requirements" SET "criteria" = ?, "sensitive_areas" = ?, "assigned_phase" = COALESCE(?, "assigned_phase") WHERE "id" = ?')
      .run(JSON.stringify(r.criteria), JSON.stringify(r.sensitive_areas), r.phase, id);
    out.push({ id, key: r.key, criteria: r.criteria, sensitive_areas: r.sensitive_areas });
  }
  recomputeIndexErrors(tx, args.project);
  return out;
}

export interface ModuleInput {
  name: string;
  paths: string[];
  sensitive_areas?: string[];
  tier_override?: string | null;
}

// The approved architecture's modules (D1 A.3; D3 §4.1; SEAM.md §222): one
// not yet registered is created; one registered again takes the paths,
// areas and override given (absent fields their defaults), the fixture's
// stand-in for an approved architecture revision (architecture approval is
// not built; modules come from this fixture only). A change of any of them
// changes every scope that takes the module, so the project's evaluations
// are stale; a recorded presence read under the former paths is unread now
// (evidence.ts presenceIn, by its basis).
export function ensureModules(tx: Tx, args: { project: string; modules: ModuleInput[] }): void {
  let changed = false;
  for (const m of args.modules) {
    const paths = JSON.stringify(m.paths);
    const areas = JSON.stringify(m.sensitive_areas ?? []);
    const override = m.tier_override ?? null;
    const row = tx.db.prepare('SELECT "id", "paths", "sensitive_areas", "tier_override" FROM "modules" WHERE "project" = ? AND "name" = ?').get(args.project, m.name) as
      | { id: string; paths: string; sensitive_areas: string; tier_override: string | null }
      | undefined;
    if (row) {
      if (row.paths === paths && row.sensitive_areas === areas && row.tier_override === override) continue;
      tx.db.prepare('UPDATE "modules" SET "paths" = ?, "sensitive_areas" = ?, "tier_override" = ? WHERE "id" = ?').run(paths, areas, override, row.id);
      changed = true;
      continue;
    }
    tx.db
      .prepare('INSERT INTO "modules" ("id", "created_at", "project", "name", "paths", "sensitive_areas", "tier_override") VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('mod_'), tx.at, args.project, m.name, paths, areas, override);
    changed = true;
  }
  if (changed) markStale(tx, { project: args.project });
}

// Module names of the project, as their ids (a stage's `modules`).
export function moduleIds(tx: Tx, projectId: string, names: string[], field: string): string[] {
  return names.map((name) => {
    const row = tx.db.prepare('SELECT "id" FROM "modules" WHERE "project" = ? AND "name" = ?').get(projectId, name) as { id: string } | undefined;
    if (!row) throw invalid(field, `names the module "${name}", which the project does not have`);
    return row.id;
  });
}

export interface CheckInput {
  key: string;
  kind: string;
  gate_kinds: string[];
  requirements: string[];
  // SEAM.md §226: the criteria it covers (its requirements are theirs too),
  // its origin, and its index in the request, for naming a refused field.
  criteria: string[];
  origin: string;
  field: number;
  required: boolean;
  tier_floor: string | null;
  sensitive_areas: string[];
  runner_class: string;
  requires: string[];
}

// Checks of the effective protected version (SEAM.md §67): the stand-in for
// what D3 discovers in the protected set.
export function declareChecks(tx: Tx, args: { project: string; checks: CheckInput[] }): { protected_version: string; checks: { id: string; key: string }[] } {
  project(tx, args.project);
  const version = mustEffective(tx.db, args.project);
  const out: { id: string; key: string }[] = [];
  const ids = JSON.parse(version.check_ids) as string[];
  const known = knownCriteria(tx.db, args.project);
  for (const c of args.checks) {
    // `requirements` (the M1 form) name what the check is required for and
    // cover no criterion (SEAM.md §226); criteria cover, and name their
    // requirements too (D3 §1.3).
    for (const k of c.criteria) if (known === null || !known.has(k)) throw invalid(`checks[${c.field}].criteria`, `names the criterion "${k}", which the registered index does not have`);
    const reqs = [...new Set([...requirementIds(tx, args.project, c.requirements, 'checks.requirements'), ...requirementIds(tx, args.project, [...new Set(c.criteria.map(requirementKeyOf))], `checks[${c.field}].criteria`)])];
    const existing = tx.db.prepare('SELECT "id" FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(version.id, c.key) as { id: string } | undefined;
    if (existing) {
      out.push({ id: existing.id, key: c.key });
      continue;
    }
    const id = tx.newId('chk_');
    tx.db
      .prepare(
        `INSERT INTO "checks" ("id", "created_at", "project", "key", "protected_version", "kind", "required", "gate_kinds", "tier_floor", "definition_path", "definition_hash",
           "requirement_ids", "sensitive_areas", "runner_class", "requires", "origin", "criteria")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tx.at,
        args.project,
        c.key,
        version.id,
        c.kind,
        c.required ? 1 : 0,
        JSON.stringify(c.gate_kinds),
        c.tier_floor,
        `.surety/checks/${c.key}`,
        version.fingerprint,
        JSON.stringify(reqs),
        JSON.stringify(c.sensitive_areas),
        c.runner_class,
        JSON.stringify(c.requires),
        c.origin,
        JSON.stringify(c.criteria),
      );
    ids.push(id);
    out.push({ id, key: c.key });
  }
  tx.db.prepare('UPDATE "protected_versions" SET "check_ids" = ? WHERE "id" = ?').run(JSON.stringify(ids), version.id);
  markStale(tx, { project: args.project });
  return { protected_version: version.id, checks: out };
}

export interface ResultInput {
  project: string;
  check: string;
  candidate: string;
  exit_status: number | null;
  source_revision?: string | undefined;
  protected_version?: string | undefined;
  runner_class?: string | undefined;
  runner_id?: string | undefined;
  environment?: string | null | undefined;
  artifact_digest?: string | null | undefined;
  execution_established?: boolean | undefined;
  signaled?: boolean | undefined;
  deadline_hit?: boolean | undefined;
  started_at?: string | null | undefined;
  finished_at?: string | null | undefined;
  output?: string | null | undefined;
}

// One execution of a check, observed (D1 §3.3; SEAM.md §67). The execution
// sequence is the engine's: it rises with every result of the project,
// whatever timestamps come with it.
export function recordCheckResult(tx: Tx, args: ResultInput, label: Record<string, unknown>): { check_result: { id: string; execution_seq: number } } {
  project(tx, args.project);
  const check = tx.db.prepare('SELECT * FROM "checks" WHERE "id" = ?').get(args.check) as { id: string; project: string; runner_class: string; key: string } | undefined;
  if (!check || check.project !== args.project) throw notFound('check', args.check);
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const version = args.protected_version ?? mustEffective(tx.db, args.project).id;
  if (args.environment) {
    const env = tx.db.prepare('SELECT "project" FROM "environments" WHERE "id" = ?').get(args.environment) as { project: string } | undefined;
    if (!env || env.project !== args.project) throw notFound('environment', args.environment);
  }
  // The project's one sequence, shared with registrations (L7).
  const n = nextExecutionSeq(tx, args.project);
  const id = tx.newId('cr_');
  tx.db
    .prepare(
      `INSERT INTO "check_results" ("id", "created_at", "project", "check", "candidate", "source_revision", "protected_version", "runner_class", "runner_id", "environment",
         "artifact_digest", "execution_seq", "execution_established", "signaled", "deadline_hit", "exit_status", "output", "started_at", "finished_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      check.id,
      candidate.id,
      args.source_revision ?? candidate.revision,
      version,
      args.runner_class ?? check.runner_class,
      args.runner_id ?? 'fixture-runner',
      args.environment ?? null,
      args.artifact_digest ?? null,
      n,
      args.execution_established === false ? 0 : 1,
      args.signaled === true ? 1 : 0,
      args.deadline_hit === true ? 1 : 0,
      args.exit_status,
      args.output ?? null,
      args.started_at ?? null,
      args.finished_at ?? null,
    );
  tx.emit('check.result', { project: args.project, check: check.id, candidate: candidate.id, check_result: id }, { ...label, execution_seq: n, exit_status: args.exit_status });
  markStale(tx, { candidate: candidate.id });
  // A fixture result is a recorded result (SEAM.md §228): the repair it
  // owes is reconciled in its transaction (D3 §2.10).
  reconcileRepairs(tx, args.project);
  return { check_result: { id, execution_seq: n } };
}

// A configured test target (SEAM.md §67). Nothing is ever deployed to it.
export function configureEnvironment(tx: Tx, args: { project: string; name: string; target_set: string[] }): { environment: { id: string } } {
  project(tx, args.project);
  const id = tx.newId('env_');
  tx.db
    .prepare('INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, args.name, 'none', 'test-target', JSON.stringify({ identity_method: 'none', behavioral_check_ids: [], target_set: args.target_set }));
  return { environment: { id } };
}

// A validation-scope approval of a proposal (E13; F §3.3): a baseline
// approval, which M1 takes as a fixture.
export function recordScopeApproval(tx: Tx, args: { project: string; proposal: string }): { approval: { id: string } } {
  project(tx, args.project);
  const p = getProposal(tx, args.proposal);
  if (!p || p.project !== args.project) throw notFound('proposal', args.proposal);
  const id = tx.newId('sapr_');
  tx.db.prepare(`INSERT INTO "scope_approvals" ("id", "created_at", "project", "kind", "proposal") VALUES (?, ?, ?, 'validation_scope', ?)`).run(id, tx.at, args.project, p.id);
  return { approval: { id } };
}

// The two things F §6.1 asks for before a High finding may be nonblocking at
// Alpha (SEAM.md §67).
export function recordAlphaException(tx: Tx, args: { finding: string; record: string; testing_purpose: string }): { finding: { id: string } } {
  const f = tx.db.prepare('SELECT "id", "project" FROM "findings" WHERE "id" = ?').get(args.finding) as { id: string; project: string } | undefined;
  if (!f) throw notFound('finding', args.finding);
  tx.db.prepare('UPDATE "findings" SET "alpha_exception" = ? WHERE "id" = ?').run(JSON.stringify({ containment_evidence: args.record, testing_purpose: args.testing_purpose }), f.id);
  markStale(tx, { project: f.project });
  return { finding: { id: f.id } };
}

// A reuse entry, stored as it is given, complete or not (SEAM.md §73).
export function recordReuse(tx: Tx, args: { project: string; candidate: string; check: string; check_result: string | null; record: string | null; assessed: boolean }): { reuse: { id: string } } {
  project(tx, args.project);
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const check = tx.db.prepare('SELECT "project" FROM "checks" WHERE "id" = ?').get(args.check) as { project: string } | undefined;
  if (!check || check.project !== args.project) throw notFound('check', args.check);
  const id = tx.newId('reuse_');
  tx.db
    .prepare('INSERT INTO "evidence_reuse" ("id", "created_at", "project", "candidate", "check", "check_result", "record", "assessed") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, candidate.id, args.check, args.check_result, args.record, args.assessed ? 1 : 0);
  markStale(tx, { candidate: candidate.id });
  return { reuse: { id } };
}

// The result row of an engine execution (D3 A.3), with `check.result` (A.6:
// its payload gains `execution` and `not_run_reason`). Called by
// checks.ts's recordExecutionResult only.
export function insertExecutionResult(
  tx: Tx,
  a: {
    project: string;
    check: string;
    candidate: string;
    source_revision: string;
    protected_version: string;
    runner_class: string;
    runner_id: string;
    runner_qualification: string | null;
    execution_seq: number;
    started_at: string | null;
    finished_at: string;
    execution: string;
    established: boolean;
    exit_status: number | null;
    signaled: boolean;
    deadline_hit: boolean;
    orphans: boolean | null;
    not_run_reason: string | null;
    output: string | null;
    output_dropped_bytes: number | null;
    // A deployment verification's binding, from its registration (D4 §5.1).
    environment?: string | null;
    artifact_digest?: string | null;
    deployment?: string | null;
  },
): string {
  const id = tx.newId('cr_');
  tx.db
    .prepare(
      `INSERT INTO "check_results" ("id", "created_at", "project", "check", "candidate", "source_revision", "protected_version", "runner_class", "runner_id", "environment",
         "artifact_digest", "execution_seq", "execution_established", "signaled", "deadline_hit", "exit_status", "output", "started_at", "finished_at",
         "execution", "not_run_reason", "orphans", "output_dropped_bytes", "runner_qualification", "deployment")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      a.project,
      a.check,
      a.candidate,
      a.source_revision,
      a.protected_version,
      a.runner_class,
      a.runner_id,
      a.environment ?? null,
      a.artifact_digest ?? null,
      a.execution_seq,
      a.established ? 1 : 0,
      a.signaled ? 1 : 0,
      a.deadline_hit ? 1 : 0,
      a.exit_status,
      a.output,
      a.started_at,
      a.finished_at,
      a.execution,
      a.not_run_reason,
      a.orphans === null ? null : a.orphans ? 1 : 0,
      a.output_dropped_bytes,
      a.runner_qualification,
      a.deployment ?? null,
    );
  tx.emit(
    'check.result',
    { project: a.project, check: a.check, candidate: a.candidate, check_result: id, check_execution: a.execution },
    { execution_seq: a.execution_seq, exit_status: a.exit_status, execution: a.execution, not_run_reason: a.not_run_reason },
  );
  markStale(tx, { candidate: a.candidate });
  return id;
}
