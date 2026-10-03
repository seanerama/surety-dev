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

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });

const project = (tx: Tx, id: string) => {
  const row = tx.db.prepare('SELECT "id", "tier" FROM "projects" WHERE "id" = ?').get(id) as { id: string; tier: string } | undefined;
  if (!row) throw notFound('project', id);
  return row;
};

// Requirements of the approved spec, by key: created once, returned after.
export function ensureRequirements(tx: Tx, args: { project: string; keys: string[] }): { id: string; key: string }[] {
  project(tx, args.project);
  const out: { id: string; key: string }[] = [];
  for (const key of args.keys) {
    const row = tx.db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(args.project, key) as { id: string } | undefined;
    if (row) {
      out.push({ id: row.id, key });
      continue;
    }
    const id = tx.newId('req_');
    tx.db
      .prepare(`INSERT INTO "requirements" ("id", "created_at", "project", "key", "text_ref", "status") VALUES (?, ?, ?, ?, ?, 'approved')`)
      .run(id, tx.at, args.project, key, `spec#${key}`);
    out.push({ id, key });
  }
  return out;
}

// The identity of a project's approved spec as M1 holds it (build spec §3:
// the baseline is a fixture; there is no spec revision row): a hash over its
// requirements, each by key with its text reference, phase and status. What
// a protected correction's preview binds as `spec_revision` (D1 A.8; Review
// B12 "approved spec"; row M53): a requirement added, removed or changed
// between the preview and the answer is a changed dependency.
export function specRevision(db: Tx['db'], projectId: string): string {
  const rows = db
    .prepare('SELECT "key", "text_ref", "assigned_phase", "status" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
    .all(projectId) as { key: string; text_ref: string; assigned_phase: number | null; status: string }[];
  return sha256(canonical(rows.map((r) => [r.key, r.text_ref, r.assigned_phase, r.status])));
}

export function requirementIds(tx: Tx, projectId: string, keys: string[], field: string): string[] {
  return keys.map((key) => {
    const row = tx.db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(projectId, key) as { id: string } | undefined;
    if (!row) throw invalid(field, `names the requirement "${key}", which the approved spec does not have`);
    return row.id;
  });
}

export function ensureModules(tx: Tx, args: { project: string; modules: { name: string; paths: string[]; sensitive_areas?: string[] }[] }): void {
  for (const m of args.modules) {
    if (tx.db.prepare('SELECT 1 FROM "modules" WHERE "project" = ? AND "name" = ?').get(args.project, m.name)) continue;
    tx.db
      .prepare('INSERT INTO "modules" ("id", "created_at", "project", "name", "paths", "sensitive_areas") VALUES (?, ?, ?, ?, ?, ?)')
      .run(tx.newId('mod_'), tx.at, args.project, m.name, JSON.stringify(m.paths), JSON.stringify(m.sensitive_areas ?? []));
  }
}

export interface CheckInput {
  key: string;
  kind: string;
  gate_kinds: string[];
  requirements: string[];
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
  for (const c of args.checks) {
    const reqs = requirementIds(tx, args.project, c.requirements, 'checks.requirements');
    const existing = tx.db.prepare('SELECT "id" FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(version.id, c.key) as { id: string } | undefined;
    if (existing) {
      out.push({ id: existing.id, key: c.key });
      continue;
    }
    const id = tx.newId('chk_');
    tx.db
      .prepare(
        `INSERT INTO "checks" ("id", "created_at", "project", "key", "protected_version", "kind", "required", "gate_kinds", "tier_floor", "definition_path", "definition_hash",
           "requirement_ids", "sensitive_areas", "runner_class", "requires")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) + 1 AS n FROM "check_results" WHERE "project" = ?').get(args.project) as { n: number };
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
