// The specification's approval (D6 §3.4, §4.1; B04; F §9.1's floor): the
// `spec_approval` decision's manifest and option blockers, and its effect,
// the one writer of `spec_revisions`: the revision with its semantic digest,
// the requirements with their criteria and text, the modules of TPL §6, the
// environments of TPL §7 by name, baseline `spec_ready`, the spec-evidence
// generation advanced (B05). A checkpoint writes nothing here (B02).
//
// Slice 31a blocks `approve` where the representation is unreadable, the
// index does not parse, or a requirement has neither a criterion nor a
// mark; slice 34 adds the duplicate, contradiction, renumbering and
// phase-hint blockers (the driver's ruling on question 4).

import { Refusal } from '../refusal.js';
import { type IndexRow } from '../checks/requirement-index.js';
import { recomputeIndexErrors } from '../store/transitions/checks.js';
import { ensureModules, ensureRequirements } from '../store/transitions/baseline.js';
import { illegal, notFound } from '../store/transitions/common.js';
import { markStale } from '../store/transitions/evidence.js';
import type { Tx } from '../store/transitions/tx.js';
import type { SemanticFinding, SpecRepresentation } from './semantics.js';

type Db = Tx['db'];

export interface SemanticsRow {
  id: string;
  project: string;
  run: string | null;
  git_blob: string;
  semantic_digest: string | null;
  representation: string | null;
  findings: string;
  readable: number;
  created_at: string;
}

// The saved representation of a session's last save (the row the save
// wrote), or none.
export function latestSemantics(db: Db, run: string): SemanticsRow | undefined {
  return db.prepare('SELECT * FROM "spec_semantics" WHERE "run" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1').get(run) as SemanticsRow | undefined;
}

// Record a save's representation (sessions/driver.ts calls it with what the
// main thread parsed from the committed blob).
export function recordSemantics(tx: Tx, args: { project: string; run: string | null; blob: string; digest: string | null; representation: SpecRepresentation | null; findings: SemanticFinding[]; readable: boolean }): string {
  const id = tx.newId('sem_');
  tx.db
    .prepare('INSERT INTO "spec_semantics" ("id", "created_at", "project", "run", "git_blob", "semantic_digest", "representation", "findings", "readable") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, args.run, args.blob, args.digest, args.representation === null ? null : JSON.stringify(args.representation), JSON.stringify(args.findings), args.readable ? 1 : 0);
  return id;
}

// The reason codes that block `approve` (D6 §3.4; A.6 `spec_semantics_invalid`).
// Slice 31's depth (the driver's ruling on question 4): B.2's forms, the
// index's agreement with section 4 (a requirement or a criterion in one and
// not the other), criterion-or-mark, the closed areas and the tier.
const BLOCKING_CODES = new Set([
  'index_invalid',
  'index_missing',
  'section_missing',
  'no_criteria_no_mark',
  'header_missing',
  'header_invalid',
  'index_subsection_mismatch',
  'criterion_mismatch',
  'area_unknown',
  'areas_missing',
]);

export function specBlockers(row: SemanticsRow | undefined): string[] {
  if (!row) return ['spec_not_saved'];
  if (row.readable !== 1) return ['spec_semantics_invalid'];
  let findings: SemanticFinding[] = [];
  try {
    findings = JSON.parse(row.findings) as SemanticFinding[];
  } catch {
    return ['spec_semantics_invalid'];
  }
  const blocking = findings.filter((f) => BLOCKING_CODES.has(f.code));
  return blocking.length > 0 ? ['spec_semantics_invalid'] : [];
}

// The effect of `approve` (D6 §3.4): one transaction.
export function approveSpec(tx: Tx, args: { project: string; run: string; decision: string }): { spec_revision: string; version: number } {
  const row = latestSemantics(tx.db, args.run);
  if (!row || row.readable !== 1 || !row.representation || !row.semantic_digest) throw illegal('approving a specification with no readable representation', { run: args.run });
  if (specBlockers(row).length > 0) throw new Refusal(409, 'spec_semantics_invalid', 'The specification cannot be approved: its representation is unreadable or incomplete.', 'Correct the specification in a session, save, and approve the next preview.', { run: args.run });
  const r = JSON.parse(row.representation) as SpecRepresentation;
  const project = tx.db.prepare('SELECT "id", "spec_evidence_generation" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; spec_evidence_generation: number } | undefined;
  if (!project) throw notFound('project', args.project);
  const prev = tx.db.prepare('SELECT "id", "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string; version: number } | undefined;
  const version = (prev?.version ?? 0) + 1;
  const id = tx.newId('spec_');
  tx.db
    .prepare('INSERT INTO "spec_revisions" ("id", "created_at", "project", "version", "git_path", "git_blob", "semantic_digest", "semantics", "approved_by", "approved_at", "supersedes", "decision") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, version, '.surety/spec/spec.md', row.git_blob, row.semantic_digest, row.id, tx.actor.actor_kind, tx.at, prev?.id ?? null, args.decision);
  // The requirements with their criteria and text (registerRequirementIndex
  // as built, extended to the representation).
  ensureRequirements(tx, { project: args.project, keys: r.requirements.map((q) => q.key), texts: Object.fromEntries(r.requirements.map((q) => [q.key, q.statement])) });
  const keys = new Set(r.requirements.map((q) => q.key));
  for (const q of r.requirements) {
    tx.db
      .prepare(
        `UPDATE "requirements" SET "text" = ?, "criteria" = ?, "criteria_text" = ?, "sensitive_areas" = ?, "assigned_phase" = COALESCE(?, "assigned_phase"), "human_test" = ?, "descriptive" = ?, "origin" = ?,
           "spec_revision" = ?, "withdrawn_at" = NULL, "status" = CASE WHEN "status" = 'withdrawn' THEN 'approved' ELSE "status" END WHERE "project" = ? AND "key" = ?`,
      )
      .run(q.statement, JSON.stringify(q.criteria.map((c) => c.id)), JSON.stringify(q.criteria), JSON.stringify(q.sensitive_areas), q.phase_hint, q.human_test ? 1 : 0, q.descriptive ? 1 : 0, q.origin, id, args.project, q.key);
  }
  // A key that disappears is withdrawn, never deleted (D6 §4.1).
  const existing = tx.db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND "withdrawn_at" IS NULL').all(args.project) as { key: string }[];
  for (const e of existing) if (!keys.has(e.key)) tx.db.prepare(`UPDATE "requirements" SET "withdrawn_at" = ?, "status" = 'withdrawn' WHERE "project" = ? AND "key" = ?`).run(tx.at, args.project, e.key);
  recomputeIndexErrors(tx, args.project);
  // TPL §6's modules, with their sensitive areas (D6 §3.4).
  if (r.modules.length > 0) ensureModules(tx, { project: args.project, modules: r.modules.map((m) => ({ name: m.name, paths: m.paths.filter((p) => p !== ''), sensitive_areas: m.sensitive_areas })) });
  // TPL §7's environments by name: a baseline operation with no adapter
  // (nothing is deployed to it until D4's configuration).
  for (const env of r.environments) {
    const exists = tx.db.prepare('SELECT "id" FROM "environments" WHERE "project" = ? AND "name" = ?').get(args.project, env.name);
    if (exists) continue;
    tx.db
      .prepare('INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec") VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('env_'), tx.at, args.project, env.name, 'none', 'spec', JSON.stringify({ identity_method: 'none', behavioral_check_ids: [], target_set: [], spec_fields: env.fields }));
  }
  const generation = project.spec_evidence_generation + 1;
  tx.db.prepare(`UPDATE "projects" SET "baseline_state" = 'spec_ready', "spec_evidence_generation" = ? WHERE "id" = ?`).run(generation, args.project);
  tx.emit('baseline.spec_approved', { project: args.project, spec_revision: id }, { version, semantic_digest: row.semantic_digest, requirements: r.requirements.length, spec_evidence_generation: generation, decision: args.decision });
  markStale(tx, { project: args.project });
  return { spec_revision: id, version };
}

export type { IndexRow };
