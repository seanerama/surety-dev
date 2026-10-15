// The specification's approval (D6 §3.4, §4.1; B04; F §9.1's floor): the
// `spec_approval` decision's manifest and option blockers, and its effect,
// the one writer of `spec_revisions`: the revision with its semantic digest,
// the requirements with their criteria and text, the modules of TPL §6, the
// environments of TPL §7 by name, baseline `spec_ready`, the spec-evidence
// generation advanced (B05). A checkpoint writes nothing here (B02).
//
// `approve` is blocked, each blocker named `CODE:subject` (SEAM.md §398),
// while the representation is unreadable, duplicate, contradictory or
// uncertain; while an open question blocks a phase-1 requirement, has no
// phase hint, or blocks a requirement with none (reading 1, strict); while a
// key is renumbered against the approved revision. The effect runs after
// the answer, with TPL §11's change log row (spec/approval-effect.ts).

import { Refusal } from '../refusal.js';
import { type IndexRow } from '../checks/requirement-index.js';
import { recomputeIndexErrors } from '../store/transitions/checks.js';
import { ensureModules, ensureRequirements } from '../store/transitions/baseline.js';
import { illegal, notFound } from '../store/transitions/common.js';
import { markStale } from '../store/transitions/evidence.js';
import type { Tx } from '../store/transitions/tx.js';
import { SPEC_BLOCKING_CODES, type SemanticFinding, type SpecRepresentation, liveRepresentation } from './semantics.js';
import { afterChange, applyConfirmations, isAdopted, recordClaims } from '../adopt/records.js';
import { canonical } from '../store/transitions/common.js';
import { blockerOf, specFinding } from '../plan/findings.js';
import { compareKeys, questionBlockers } from './keys.js';
import { staleUnpublishable } from '../plan/bundle.js';

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
  return db.prepare('SELECT * FROM "spec_semantics" WHERE "run" = ? ORDER BY rowid DESC, "id" DESC LIMIT 1').get(run) as SemanticsRow | undefined;
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

// The reason codes that block `approve` (D6 §3.4; A.6 `spec_semantics_invalid`):
// B.2's forms, the index's agreement with section 4 (a requirement or a
// criterion in one and not the other), criterion-or-mark, the closed areas
// and the tier, duplicates, and any part that could not be read.
const BLOCKING_CODES = new Set(SPEC_BLOCKING_CODES);

// The findings of a parsed specification that block its approval (S1 of
// the 31b review: a spec change is refused on them at acceptance).
export function blockingFindings(findings: readonly SemanticFinding[]): SemanticFinding[] {
  return findings.filter((f) => BLOCKING_CODES.has(f.code));
}

// The representation a row holds, or why it cannot be read (never a
// default: D6 §3.4, M449 (e)).
export function readRepresentation(row: SemanticsRow | undefined): { rep: SpecRepresentation; findings: SemanticFinding[] } | { cause: string } {
  if (!row) return { cause: 'the specification was never saved' };
  let findings: SemanticFinding[];
  try {
    findings = JSON.parse(row.findings) as SemanticFinding[];
    if (!Array.isArray(findings)) throw new Error('not a list');
  } catch {
    return { cause: "the save's findings cannot be read" };
  }
  if (row.readable !== 1) return { cause: findings.map((f) => f.why).join('; ') || 'the specification has neither section 4 nor section 5' };
  if (row.representation === null || row.semantic_digest === null) return { cause: 'the save recorded no representation' };
  try {
    const rep = JSON.parse(row.representation) as SpecRepresentation;
    if (typeof rep !== 'object' || rep === null || !Array.isArray(rep.requirements) || !Array.isArray(rep.questions)) throw new Error('not a representation');
    return { rep: liveRepresentation(rep), findings };
  } catch {
    return { cause: 'the saved representation does not parse' };
  }
}

// What the approved revision's keys are compared against: its
// representation, null when no specification is approved, or `unreadable`
// (the review's N3 (b): never a skipped comparison), with the keys the
// project has withdrawn (the review's N4).
export interface ApprovedKeys {
  rep: SpecRepresentation | null | 'unreadable';
  withdrawn: string[];
}

// The keys a used-again check reads (TPL §4; the review's N4): the keys the
// project withdrew whose requirement left the approved text. A key withdrawn
// by the owner's answer at confirmation (D6 §8.1 step 2) stays in the text,
// and keeping it there is not a reuse.
export function vanishedKeys(db: Db, project: string, rep: SpecRepresentation | null | 'unreadable'): string[] {
  const withdrawn = (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND "withdrawn_at" IS NOT NULL ORDER BY "key"').all(project) as { key: string }[]).map((r) => r.key);
  if (rep === null || rep === 'unreadable') return withdrawn;
  const kept = new Set(rep.requirements.filter((r) => r.withdrawn !== true).map((r) => r.key));
  return withdrawn.filter((k) => !kept.has(k));
}

export function approvedRepresentation(db: Db, project: string): ApprovedKeys {
  const keysOf = (rep: SpecRepresentation | null | 'unreadable'): ApprovedKeys => ({ rep, withdrawn: vanishedKeys(db, project, rep) });
  const v = db.prepare('SELECT "semantics" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { semantics: string | null } | undefined;
  if (!v) return keysOf(null);
  const row = v.semantics === null ? undefined : (db.prepare('SELECT "representation" FROM "spec_semantics" WHERE "id" = ?').get(v.semantics) as { representation: string | null } | undefined);
  if (!row?.representation) return keysOf('unreadable');
  try {
    const rep = JSON.parse(row.representation) as SpecRepresentation;
    if (typeof rep !== 'object' || rep === null || !Array.isArray(rep.requirements)) return keysOf('unreadable');
    return keysOf(liveRepresentation(rep));
  } catch {
    return keysOf('unreadable');
  }
}

// The representation of the project's last readable save (any session's),
// against which a save's keys are compared (M421 (c)); null when none.
export function previousRepresentation(db: Db, project: string): SpecRepresentation | null {
  // A session's save only: a specification change's proposal is no save
  // (the review's N5).
  const row = db
    .prepare(`SELECT s."representation" FROM "spec_semantics" s JOIN "runs" r ON r."id" = s."run" WHERE s."project" = ? AND s."readable" = 1 AND s."representation" IS NOT NULL AND r."kind" = 'session' ORDER BY s.rowid DESC, s."id" DESC LIMIT 1`)
    .get(project) as { representation: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.representation) as SpecRepresentation;
  } catch {
    return null;
  }
}

// The blockers of `approve` (D6 §3.4; B04; M421 (f), M422 (a), M449 (e)),
// each `CODE:subject`: `spec_semantics_invalid` first whenever the
// representation is unreadable, duplicate, contradictory or uncertain, then
// one per finding that blocks; the open questions of reading 1; a key
// renumbered against the approved revision (`approved`, when one exists).
// `questions` false: a specification change's approval, which carries no
// phase-hint guard (the driver's ruling; SEAM.md §402).
export function specBlockers(row: SemanticsRow | undefined, approved: ApprovedKeys = { rep: null, withdrawn: [] }, opts: { questions?: boolean } = {}): string[] {
  if (!row) return ['spec_not_saved'];
  const read = readRepresentation(row);
  if ('cause' in read) return ['spec_semantics_invalid', `SPEC_REPRESENTATION_UNREADABLE:${read.cause}`];
  const out: string[] = [];
  const blocking = read.findings.filter((f) => BLOCKING_CODES.has(f.code));
  if (blocking.length > 0) out.push('spec_semantics_invalid', ...new Set(blocking.map((f) => blockerOf(specFinding(f)))));
  if (opts.questions !== false) out.push(...questionBlockers(read.rep));
  if (approved.rep === 'unreadable') out.push('SPEC_REPRESENTATION_UNREADABLE:previous');
  else for (const r of compareKeys(approved.rep, read.rep).renumbered) out.push(`spec_keys_renumbered:${r.from}->${r.key}`);
  // A withdrawn key used again (TPL §4: never reused; the review's N4).
  for (const r of read.rep.requirements) if (approved.withdrawn.includes(r.key)) out.push(`spec_key_reused:${r.key}`);
  return out;
}

// The effect of `approve` (D6 §3.4): one transaction.
// The keys of `r` whose requirement differs from the approved revision
// `prev` (statement, criteria, areas, marks, phase hint), or is new.
function alteredKeys(db: Db, prev: string | null, r: SpecRepresentation): Set<string> {
  const all = new Set(r.requirements.map((q) => q.key));
  if (prev === null) return all;
  const row = db.prepare('SELECT s."representation" FROM "spec_revisions" v JOIN "spec_semantics" s ON s."id" = v."semantics" WHERE v."id" = ?').get(prev) as { representation: string | null } | undefined;
  let before: SpecRepresentation | null = null;
  try {
    before = row?.representation ? liveRepresentation(JSON.parse(row.representation) as SpecRepresentation) : null;
  } catch {
    before = null;
  }
  // Unread, the change is taken to alter every key: nothing is kept on an
  // unknown.
  if (before === null) return all;
  const shape = (q: SpecRepresentation['requirements'][number]) => canonical({ statement: q.statement, criteria: q.criteria, sensitive_areas: [...q.sensitive_areas].sort(), human_test: q.human_test, descriptive: q.descriptive, phase_hint: q.phase_hint });
  const old = new Map(before.requirements.map((q) => [q.key, shape(q)]));
  return new Set(r.requirements.filter((q) => old.get(q.key) !== shape(q)).map((q) => q.key));
}

// `via`: a Spec Writer session's `spec_approval` (the retrofit
// confirmations apply), or a specification change's application.
export function approveSpec(tx: Tx, args: { project: string; run: string; decision: string; via?: 'session' | 'change'; blob?: string }): { spec_revision: string; version: number } {
  // Once per decision: a finalizer replayed by recovery writes nothing twice.
  const done = tx.db.prepare('SELECT "id", "version" FROM "spec_revisions" WHERE "project" = ? AND "decision" = ?').get(args.project, args.decision) as { id: string; version: number } | undefined;
  if (done) return { spec_revision: done.id, version: done.version };
  const row = latestSemantics(tx.db, args.run);
  const read = readRepresentation(row);
  // Never a default (M449 (e)): what cannot be read is refused, naming why.
  if ('cause' in read) throw new Refusal(409, 'spec_semantics_invalid', `The specification cannot be approved: ${read.cause}.`, 'Correct the specification in a session, save, and approve the next preview.', { run: args.run, cause: read.cause });
  const blockers = specBlockers(row, approvedRepresentation(tx.db, args.project), { questions: (args.via ?? 'session') === 'session' });
  if (blockers.length > 0) throw new Refusal(409, 'spec_semantics_invalid', `The specification cannot be approved: ${blockers.join(', ')}.`, 'Correct the specification in a session, save, and approve the next preview.', { run: args.run, blockers });
  const r = read.rep;
  const sem = row!;
  const project = tx.db.prepare('SELECT "id", "spec_evidence_generation" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; spec_evidence_generation: number } | undefined;
  if (!project) throw notFound('project', args.project);
  const prev = tx.db.prepare('SELECT "id", "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string; version: number } | undefined;
  const version = (prev?.version ?? 0) + 1;
  const id = tx.newId('spec_');
  // The blob is the approved file as committed with the engine's change log
  // row (TPL §11; the coordinator's ruling on question 2), when the effect
  // made that commit; the digest is the saved representation's, which §11
  // is not part of.
  tx.db
    .prepare('INSERT INTO "spec_revisions" ("id", "created_at", "project", "version", "git_path", "git_blob", "semantic_digest", "semantics", "approved_by", "approved_at", "supersedes", "decision") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, version, '.surety/spec/spec.md', args.blob ?? sem.git_blob, sem.semantic_digest, sem.id, tx.actor.actor_kind, tx.at, prev?.id ?? null, args.decision);
  // The requirements with their criteria and text (registerRequirementIndex
  // as built, extended to the representation).
  ensureRequirements(tx, { project: args.project, keys: r.requirements.map((q) => q.key), texts: Object.fromEntries(r.requirements.map((q) => [q.key, q.statement])) });
  const keys = new Set(r.requirements.map((q) => q.key));
  // An adopted project's specification change acts only on the keys it
  // altered (the slice-32 review's S3; B10, D6-R03, E6): the owner's
  // withdraw, defect and unanswered answers stand on every other key.
  const altered = (args.via ?? 'session') === 'change' && isAdopted(tx.db, args.project) ? alteredKeys(tx.db, prev?.id ?? null, r) : null;
  // A requirement's phase is the roadmap's (D6 §4.5, §5.1): the index's hint
  // is written only by a session's approval before any roadmap exists; a
  // change keeps the phase of a key the roadmap names and leaves an added
  // key with none, whatever its hint (Q8), until a roadmap revision places it.
  const roadmap = tx.db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(args.project) !== undefined;
  const hints = (args.via ?? 'session') === 'session' && !roadmap;
  const before = new Set((tx.db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND "spec_revision" IS NOT NULL').all(args.project) as { key: string }[]).map((q) => q.key));
  for (const q of r.requirements) {
    if (altered !== null && !altered.has(q.key)) {
      tx.db.prepare('UPDATE "requirements" SET "spec_revision" = ? WHERE "project" = ? AND "key" = ?').run(id, args.project, q.key);
      continue;
    }
    tx.db
      .prepare(
        `UPDATE "requirements" SET "text" = ?, "criteria" = ?, "criteria_text" = ?, "sensitive_areas" = ?, "assigned_phase" = COALESCE(?, "assigned_phase"), "human_test" = ?, "descriptive" = ?, "origin" = ?,
           "spec_revision" = ?, "withdrawn_at" = NULL, "status" = CASE WHEN "status" = 'withdrawn' THEN 'approved' ELSE "status" END WHERE "project" = ? AND "key" = ?`,
      )
      .run(q.statement, JSON.stringify(q.criteria.map((c) => c.id)), JSON.stringify(q.criteria), JSON.stringify(q.sensitive_areas), hints ? q.phase_hint : null, q.human_test ? 1 : 0, q.descriptive ? 1 : 0, q.origin, id, args.project, q.key);
    // A key a change adds is pending: no gate has verified it (D6 §4.1; the
    // driver's ruling Q-C).
    if ((args.via ?? 'session') === 'change' && !before.has(q.key)) tx.db.prepare(`UPDATE "requirements" SET "status" = 'pending' WHERE "project" = ? AND "key" = ? AND "status" = 'approved'`).run(args.project, q.key);
  }
  // A key that disappears is withdrawn, never deleted (D6 §4.1).
  const existing = tx.db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND "withdrawn_at" IS NULL').all(args.project) as { key: string }[];
  for (const e of existing) if (!keys.has(e.key)) tx.db.prepare(`UPDATE "requirements" SET "withdrawn_at" = ?, "status" = 'withdrawn' WHERE "project" = ? AND "key" = ?`).run(tx.at, args.project, e.key);
  // An adopted project's confirmations (D6 §8.1 step 2; B10), and TPL §12's
  // claims table (K10).
  if ((args.via ?? 'session') === 'session') applyConfirmations(tx, { project: args.project, rep: r, blob: sem.git_blob });
  else afterChange(tx, { project: args.project, rep: r, altered: altered ?? new Set(r.requirements.map((q) => q.key)) });
  recordClaims(tx, { project: args.project, specRevision: id, rep: r });
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
  tx.emit('baseline.spec_approved', { project: args.project, spec_revision: id }, { version, semantic_digest: sem.semantic_digest, git_blob: args.blob ?? sem.git_blob, requirements: r.requirements.length, spec_evidence_generation: generation, decision: args.decision });
  markStale(tx, { project: args.project });
  // A proposal checked against the superseded specification can never
  // publish (D6 §5.5; B02): it is stale now, not at its answer (M448 (d)).
  staleUnpublishable(tx, args.project, `the approved specification advanced to version ${version}`);
  return { spec_revision: id, version };
}

export type { IndexRow };
