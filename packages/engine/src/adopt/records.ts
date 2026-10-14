// The adoption's records and the retrofit decisions (D6 §8.1 steps 1 and 2,
// §8.2; K10; B10, B11; E6; D1 A.8; SEAM.md §§377 to 380, 384). Store side:
// every function here runs in a transaction.
//
// - The adoption: the project with its bootstrap, `projects.adoption` with
//   the immutable source revision A recorded in the same transaction that
//   intends the bootstrap commit (migration 0025's trigger refuses any later
//   change of it), the signals as observed evidence, the environments the
//   signals suggest (`unknown` by name, no adapter), the tags as
//   `external_unverified` releases, `project.adopted`, and the owner's
//   `adoption_mode` decision. While that decision is unanswered the mode is
//   null, with the reason, and never defaulted.
// - `requirement_confirm`: one per requirement a retrofit Spec Writer session
//   produced, whatever its `Origin` says (provenance is engine-owned, B10),
//   except one bound to the owner's approved idea text; each bound to the
//   exact statement, criteria and specification blob; consumed on its own;
//   applied when the specification is approved.
// - The mode rules of `spec_approval` (D6-R09): in `full` mode `approve` is
//   blocked while a produced requirement is unanswered, or is confirmed (or
//   a defect) without criteria; in `scoped` mode the unanswered and the
//   criterion-less are recorded `descriptive_unverified`.

import { liveRepresentation } from '../spec/semantics.js';
import { Refusal } from '../refusal.js';
import { canonical, parseJson } from '../store/transitions/common.js';
import { type DecisionRow, consumeDecision } from '../store/transitions/decisions.js';
import { type PreparedCommit, bootstrapProject } from '../store/transitions/project.js';
import type { ProtectedSet } from '../store/transitions/protected.js';
import { type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import { policyRevision } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import type { SpecRepresentation, SemanticRequirement } from '../spec/semantics.js';
import type { AdoptionSignals } from './adopt.js';

type Db = Tx['db'];

export type AdoptionMode = 'full' | 'scoped';

export interface Adoption {
  pinned_revision: string;
  branch: string;
  signals: AdoptionSignals;
  recommended_mode: AdoptionMode | null;
  threshold: number;
  source_digest: string;
  idea_given: boolean;
  idea_first_version: string[];
  // The environments the signals name, or unknown with the names read.
  environments?: string[] | { unknown: string; named: string[] };
  tracked_paths?: string[];
  tracked_paths_total?: number | { unknown: string };
  mode: AdoptionMode | null;
  // Why the mode is null: the owner's decision is not answered yet.
  mode_reason: string | null;
  mode_decision: string | null;
  adopted_at: string;
}

export function adoptionOf(db: Db, project: string): Adoption | null {
  const row = db.prepare('SELECT "adoption" FROM "projects" WHERE "id" = ?').get(project) as { adoption: string | null } | undefined;
  return parseJson<Adoption>(row?.adoption ?? null);
}

export const isAdopted = (db: Db, project: string): boolean => adoptionOf(db, project) !== null;

// ---- the adoption (D6 §8.1 step 1; SEAM.md §§377, 378) --------------------------------------

export interface AdoptArgs {
  id: string;
  name: string;
  tier: string;
  repo: string;
  branch: string;
  head: string;
  commit: PreparedCommit;
  deadlineSeconds: number;
  protectedSet: ProtectedSet;
  idea?: { blob: string };
  adoption: Omit<Adoption, 'mode' | 'mode_reason' | 'mode_decision' | 'adopted_at'>;
  environments: string[];
  tags: { name: string; revision: string }[];
}

export function adoptProject(tx: Tx, args: AdoptArgs): { project: { id: string; registration_state: string; adoption: Adoption } } {
  // The repository held by another project (Q1), checked again here.
  const holder = tx.db.prepare('SELECT "id", "name" FROM "projects" WHERE "dev_repo_path" = ?').get(args.repo) as { id: string; name: string } | undefined;
  if (holder) throw new Refusal(409, 'adoption_repository_in_use', `The repository ${args.repo} is already the repository of project ${holder.name} (${holder.id}).`, 'Adopt a repository no project holds; nothing was created.', { path: args.repo, project: holder.id, name: holder.name });
  if (args.adoption.pinned_revision !== args.head) throw new Refusal(409, 'adoption_branch_moved', `The branch moved from ${args.adoption.pinned_revision} to ${args.head} after the adoption observed it.`, 'Adopt again; nothing was created.', { observed: args.adoption.pinned_revision, found: args.head });
  const made = bootstrapProject(tx, args);
  const id = made.project.id;
  // A, recorded here, in the transaction that intends the bootstrap commit
  // on top of it (B11), and never updated (migration 0025's trigger).
  const adoption: Adoption = { ...args.adoption, mode: null, mode_reason: 'the owner has not answered the adoption_mode decision', mode_decision: null, adopted_at: tx.at };
  tx.db.prepare('UPDATE "projects" SET "adoption" = ? WHERE "id" = ?').run(JSON.stringify(adoption), id);
  tx.emit('project.adopted', { project: id }, { pinned_revision: adoption.pinned_revision, branch: adoption.branch, recommended_mode: adoption.recommended_mode, signals: adoption.signals, source_digest: adoption.source_digest });
  // The environments the signals suggest are deployed: environment facts,
  // unknown by name, with no adapter (E6). The engine never reads or
  // deploys to them.
  for (const name of args.environments) {
    if (tx.db.prepare('SELECT 1 FROM "environments" WHERE "project" = ? AND "name" = ?').get(id, name)) continue;
    tx.db
      .prepare('INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "origin") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('env_'), tx.at, id, name, 'none', 'adoption_signal', JSON.stringify({ identity_method: 'none', behavioral_check_ids: [], target_set: [] }), 'adoption_signal');
  }
  // Releases the repository tags: external_unverified, no artifact, never
  // a candidate's progress (E6).
  for (const t of args.tags) {
    tx.db.prepare(`INSERT INTO "releases" ("id", "created_at", "project", "name", "revision", "state", "artifact", "candidate") VALUES (?, ?, ?, ?, ?, 'external_unverified', NULL, NULL)`).run(tx.newId('rel_'), tx.at, id, t.name, t.revision);
  }
  const mode = raiseQuestion(tx, { project: id, kind: 'adoption_mode', subjectType: 'project', subjectId: id });
  if (mode) {
    const withReason = { ...adoption, mode_reason: `the owner has not answered the adoption_mode decision ${mode.id}` };
    tx.db.prepare('UPDATE "projects" SET "adoption" = ? WHERE "id" = ?').run(JSON.stringify(withReason), id);
    return { project: { ...made.project, adoption: withReason } };
  }
  return { project: { ...made.project, adoption } };
}

// ---- adoption_mode (D1 A.8; E6; SEAM.md §377) ------------------------------------------------

export const ADOPTION_MODE_KEYS = ['pinned_revision', 'signals', 'policy_revision'];

function modeManifest(db: Db, project: string): Record<string, unknown> | null {
  const a = adoptionOf(db, project);
  if (!a) return null;
  return { pinned_revision: a.pinned_revision, signals: a.signals, recommended_mode: a.recommended_mode, threshold: a.threshold, mode: a.mode, policy_revision: policyRevision(db, project) };
}

export const ADOPTION_MODE: KindSpec = {
  preview(tx, d: Subject) {
    const a = adoptionOf(tx.db, d.subject_id);
    if (!a || a.mode !== null) return null;
    const manifest = modeManifest(tx.db, d.subject_id)!;
    const files = typeof a.signals.files === 'number' ? `${a.signals.files} tracked files` : 'an unknown number of tracked files';
    return {
      manifest,
      question: `How is the adopted repository to be specified? A (${a.pinned_revision}) has ${files}; the engine recommends ${a.recommended_mode ?? 'nothing (the size is unknown)'} at a threshold of ${a.threshold} files.`,
      options: [
        { key: 'full', label: 'Full', consequence: 'Every behaviour of the code gets a requirement with criteria; the specification is approved only once each produced requirement is confirmed, a defect or withdrawn.', effect: { mode: 'full' } },
        { key: 'scoped', label: 'Scoped', consequence: 'Every requirement is listed; criteria are written only for the modules you name for the first changes, the others stay descriptive_unverified and no plan may touch their modules until they have criteria.', effect: { mode: 'scoped' } },
      ],
      // The signals as observed evidence, with the recommendation (§377).
      evidence: { signals: a.signals, recommended_mode: a.recommended_mode, threshold: a.threshold, pinned_revision: a.pinned_revision, provenance: 'observed' } as never,
    };
  },
  manifest: (tx, d) => modeManifest(tx.db, d.subject_id) ?? {},
  // The question stands until answered: a changed binding (a policy
  // revision) raises its next generation.
  reraise: true,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    const a = adoptionOf(tx.db, d.subject_id)!;
    const next: Adoption = { ...a, mode: option as AdoptionMode, mode_reason: null, mode_decision: d.id };
    tx.db.prepare('UPDATE "projects" SET "adoption" = ? WHERE "id" = ?').run(JSON.stringify(next), d.subject_id);
    recordApproval(tx, d, { consequence: `adoption mode ${option}`, subjectType: 'project', subjectId: d.subject_id });
    // An open specification approval's mode rule changed with it.
    for (const s of tx.db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'spec_approval' AND "status" = 'open'`).all(d.subject_id) as DecisionRow[]) reraiseSpecApproval(tx, s);
    return consumed(d);
  },
};

// ---- requirement_confirm (D6 §8.1 step 2; K10; B10; SEAM.md §379) ------------------------------

export const REQUIREMENT_CONFIRM_KEYS = ['key', 'text', 'criteria', 'blob'];

interface SemanticsRowLite {
  git_blob: string;
  representation: string | null;
  readable: number;
}

const semanticsOfRun = (db: Db, run: string): SemanticsRowLite | undefined =>
  db.prepare('SELECT "git_blob", "representation", "readable" FROM "spec_semantics" WHERE "run" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1').get(run) as SemanticsRowLite | undefined;

// The specification awaiting approval: the run of the newest open
// `spec_approval`, and its last save's representation.
function pendingSpecification(db: Db, project: string): { run: string; blob: string; rep: SpecRepresentation } | null {
  const d = db.prepare(`SELECT "subject_id" FROM "decisions" WHERE "project" = ? AND "kind" = 'spec_approval' AND "status" = 'open' ORDER BY "seq" DESC LIMIT 1`).get(project) as { subject_id: string } | undefined;
  if (!d) return null;
  const row = semanticsOfRun(db, d.subject_id);
  if (!row || row.readable !== 1) return null;
  const rep = liveRepresentation(parseJson<SpecRepresentation>(row.representation));
  return rep ? { run: d.subject_id, blob: row.git_blob, rep } : null;
}

// Bound to an approved owner-authored requirement: its statement is an item
// of the idea's "First version" given at adoption (§379, the Verifier's
// reading). Such a requirement gets no row.
export const boundToIdea = (a: Adoption, q: Pick<SemanticRequirement, 'statement'>): boolean => a.idea_first_version.some((s) => s.trim() === q.statement.trim());

const criteriaOf = (q: SemanticRequirement) => q.criteria.map((c) => ({ id: c.id, text: c.text }));

function confirmManifest(project: string, q: SemanticRequirement, blob: string, run: string, db: Db): Record<string, unknown> {
  return { key: q.key, text: q.statement, criteria: criteriaOf(q), blob, run, policy_revision: policyRevision(db, project) };
}

// The owner's answer for a produced requirement as the specification now
// states it: the newest consumed `requirement_confirm` about its key whose
// binding (text, criteria, blob) is this one; null when none.
export function confirmationOf(db: Db, project: string, q: SemanticRequirement, blob: string): { option: string; decision: string } | null {
  const rows = db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'requirement_confirm' AND "subject_id" = ? AND "status" = 'consumed' ORDER BY "semantic_generation" DESC`).all(project, q.key) as (DecisionRow & { answer: string | null })[];
  for (const d of rows) {
    const m = parseJson<{ text?: string; criteria?: unknown; blob?: string }>(d.dependency_manifest);
    if (!m || m.blob !== blob || m.text !== q.statement || canonical(m.criteria ?? null) !== canonical(criteriaOf(q))) continue;
    const option = parseJson<{ option?: string }>(d.answer)?.option;
    if (typeof option === 'string') return { option, decision: d.id };
  }
  return null;
}

export const REQUIREMENT_CONFIRM: KindSpec = {
  preview(tx, d: Subject) {
    if (d.project === null) return null;
    const a = adoptionOf(tx.db, d.project);
    if (!a) return null;
    const pending = pendingSpecification(tx.db, d.project);
    if (!pending) return null;
    const q = pending.rep.requirements.find((r) => r.key === d.subject_id);
    if (!q || boundToIdea(a, q)) return null;
    const manifest = confirmManifest(d.project, q, pending.blob, pending.run, tx.db);
    return {
      manifest,
      question: `The retrofit specification states ${q.key} as "${q.statement}"${q.criteria.length > 0 ? ` with ${q.criteria.map((c) => c.id).join(', ')}` : ' with no criteria'} (Origin ${q.origin}, the role's claim). Is it what you intend?`,
      options: [
        { key: 'confirm', label: 'Confirm', consequence: `${q.key} is kept as intended behaviour: pending, delivered by the phase the roadmap assigns.`, effect: { key: q.key, option: 'confirm' } },
        { key: 'defect', label: 'Defect', consequence: `${q.key} states the intended behaviour and the code is wrong: pending, a defect, scheduled to a later phase and out of the conformance set.`, effect: { key: q.key, option: 'defect' } },
        { key: 'withdraw', label: 'Withdraw', consequence: `${q.key} is not wanted: withdrawn.`, effect: { key: q.key, option: 'withdraw' } },
      ],
      evidence: [{ record: pending.blob, path: '.surety/spec/spec.md', provenance: 'claimed' } as never],
    };
  },
  manifest(tx, d) {
    if (d.project === null) return {};
    const pending = pendingSpecification(tx.db, d.project);
    const q = pending?.rep.requirements.find((r) => r.key === d.subject_id);
    return pending && q ? confirmManifest(d.project, q, pending.blob, pending.run, tx.db) : {};
  },
  reraise: true,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    recordApproval(tx, d, { consequence: `requirement ${d.subject_id} answered ${option}`, subjectType: 'requirement', subjectId: d.subject_id });
    // The batch's specification approval is raised again with its blockers
    // as they now stand (D6-R09): the open approval is never stale because a
    // confirmation was answered.
    const m = parseJson<{ run?: string }>(d.dependency_manifest);
    if (m?.run) {
      const s = tx.db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'spec_approval' AND "subject_type" = 'run' AND "subject_id" = ? AND "status" = 'open' ORDER BY "semantic_generation" DESC LIMIT 1`).get(d.project, m.run) as DecisionRow | undefined;
      if (s) reraiseSpecApproval(tx, s);
    }
    return consumed(d);
  },
};

function reraiseSpecApproval(tx: Tx, s: DecisionRow): void {
  const next = raiseQuestion(tx, { project: s.project, kind: 'spec_approval', subjectType: s.subject_type, subjectId: s.subject_id, scope: s.scope });
  if (next && next.id !== s.id && s.batch_key) tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "id" = ?').run(s.batch_key, next.id);
}

// At a retrofit Spec Writer's close (D6 §8.1 step 2): the requirements the
// session produced that need the owner's answer, each raised in the batch.
export function raiseConfirmations(tx: Tx, args: { project: string; run: string; approval: DecisionRow | null }): DecisionRow[] {
  const a = adoptionOf(tx.db, args.project);
  if (!a || !args.approval) return [];
  const batch = `retrofit:${args.run}`;
  const row = semanticsOfRun(tx.db, args.run);
  const rep = row && row.readable === 1 ? liveRepresentation(parseJson<SpecRepresentation>(row.representation)) : null;
  const out: DecisionRow[] = [];
  for (const q of rep?.requirements ?? []) {
    if (boundToIdea(a, q)) continue;
    const d = raiseQuestion(tx, { project: args.project, kind: 'requirement_confirm', subjectType: 'requirement', subjectId: q.key });
    if (d) out.push(d);
  }
  const ids = [args.approval.id, ...out.map((d) => d.id)];
  tx.db.prepare(`UPDATE "decisions" SET "batch_key" = ? WHERE "id" IN (${ids.map(() => '?').join(', ')})`).run(batch, ...ids);
  return out.map((d) => ({ ...d, batch_key: batch }));
}

// The mode rules (D6-R09; SEAM.md §384) as option blockers of `approve`,
// each naming the requirement. Empty outside an adopted project.
export function retrofitBlockers(db: Db, project: string | null, run: string): string[] {
  if (project === null) return [];
  const a = adoptionOf(db, project);
  if (!a) return [];
  if (a.mode === null) return ['ADOPTION_MODE_UNANSWERED'];
  if (a.mode === 'scoped') return [];
  const row = semanticsOfRun(db, run);
  const rep = row && row.readable === 1 ? liveRepresentation(parseJson<SpecRepresentation>(row.representation)) : null;
  if (!rep || !row) return [];
  const out: string[] = [];
  for (const q of rep.requirements) {
    if (boundToIdea(a, q)) continue;
    const answer = confirmationOf(db, project, q, row.git_blob);
    if (answer === null) out.push(`REQUIREMENT_UNANSWERED:${q.key}`);
    else if ((answer.option === 'confirm' || answer.option === 'defect') && q.criteria.length === 0) out.push(`REQUIREMENT_NO_CRITERIA:${q.key}`);
  }
  return out;
}

// The answers applied in the approval's transaction (D6 §8.1 step 2;
// SEAM.md §379): confirm → pending; defect → pending, a defect, a later
// phase; withdraw → withdrawn; bound to the idea → pending; unanswered or
// criterion-less in scoped mode → descriptive_unverified. Every produced
// requirement is reverse_engineered.
export function applyConfirmations(tx: Tx, args: { project: string; rep: SpecRepresentation; blob: string }): void {
  const a = adoptionOf(tx.db, args.project);
  if (!a) return;
  if (a.mode === null) throw new Refusal(409, 'illegal_transition', 'The specification of an adopted project cannot be approved before the adoption mode is chosen.', 'Answer the adoption_mode decision, then approve the next preview.', { project: args.project });
  const set = (key: string, sql: string, ...params: unknown[]) => tx.db.prepare(`UPDATE "requirements" SET ${sql} WHERE "project" = ? AND "key" = ?`).run(...params, args.project, key);
  // A defect's later phase is set here only before any roadmap: once one
  // exists, a requirement's phase is the roadmap's (D6 §4.5; the driver's
  // ruling Q-G), and the Architect places it.
  const later = tx.db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(args.project) === undefined ? 1 : 0;
  for (const q of args.rep.requirements) {
    set(q.key, '"reverse_engineered" = 1, "defect" = 0, "confirmed_at" = NULL, "confirmed_by" = NULL');
    if (boundToIdea(a, q)) {
      set(q.key, `"status" = 'pending', "confirmed_at" = ?, "confirmed_by" = ?`, tx.at, 'idea');
      continue;
    }
    const answer = confirmationOf(tx.db, args.project, q, args.blob);
    const option = answer?.option ?? null;
    if (a.mode === 'full' && (option === null || ((option === 'confirm' || option === 'defect') && q.criteria.length === 0))) {
      throw new Refusal(409, 'illegal_transition', `The specification cannot be approved in full mode: ${q.key} is ${option === null ? 'unanswered' : 'without criteria'}.`, 'Answer every requirement_confirm with criteria, then approve the next preview.', { requirement: q.key });
    }
    if (option === 'withdraw') {
      set(q.key, `"status" = 'withdrawn', "withdrawn_at" = ?`, tx.at);
    } else if (option === 'defect' && q.criteria.length > 0) {
      // A defect's delivery belongs to a later phase (§8.1 step 2).
      set(q.key, `"status" = 'pending', "defect" = 1, "confirmed_at" = ?, "confirmed_by" = ?, "assigned_phase" = CASE WHEN ? = 1 THEN MAX(COALESCE("assigned_phase", 2), 2) ELSE "assigned_phase" END`, tx.at, answer!.decision, later);
    } else if (option === 'confirm' && q.criteria.length > 0) {
      set(q.key, `"status" = 'pending', "confirmed_at" = ?, "confirmed_by" = ?`, tx.at, answer!.decision);
      tx.emit('requirement.confirmed', { project: args.project, requirement: q.key }, { decision: answer!.decision, origin: q.origin });
    } else {
      // Scoped mode: never silently promoted (E6). A defect answered for a
      // requirement with no criteria yet keeps the owner's mark (the slice-32
      // review's M6).
      set(q.key, `"status" = 'descriptive_unverified', "defect" = ?, "assigned_phase" = CASE WHEN ? = 1 THEN MAX(COALESCE("assigned_phase", 2), 2) ELSE "assigned_phase" END`, option === 'defect' ? 1 : 0, option === 'defect' ? later : 0);
    }
  }
  // Every open confirmation of this approval is settled by it.
}

// TPL §12 "Claims and reality" (K10; SEAM.md §380), recorded at approval.
export function recordClaims(tx: Tx, args: { project: string; specRevision: string; rep: SpecRepresentation }): void {
  args.rep.claims.forEach((c, i) => {
    const req = c.requirement === null ? undefined : (tx.db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(args.project, c.requirement) as { id: string } | undefined);
    tx.db
      .prepare('INSERT INTO "spec_claims" ("id", "created_at", "spec_revision", "ordinal", "claim_source", "claim", "observed", "requirement") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('claim_'), tx.at, args.specRevision, i + 1, c.source, c.claim, c.observed, req?.id ?? null);
  });
}

// An approved specification change in an adopted project (D6 §8.3), on
// the keys it altered only (the slice-32 review's S3): a
// descriptive_unverified requirement the change gives criteria leaves that
// state, the owner's approval of the change being the explicit act on the
// identified requirement; a requirement the change adds, or reinstates after
// a withdrawal, is the owner's own and pending. Every other status stands.
export function afterChange(tx: Tx, args: { project: string; rep: SpecRepresentation; altered: Set<string> }): void {
  if (!isAdopted(tx.db, args.project)) return;
  for (const q of args.rep.requirements) {
    if (!args.altered.has(q.key)) continue;
    if (q.criteria.length > 0) tx.db.prepare(`UPDATE "requirements" SET "status" = 'pending', "confirmed_at" = ?, "confirmed_by" = 'spec_change' WHERE "project" = ? AND "key" = ? AND "status" = 'descriptive_unverified'`).run(tx.at, args.project, q.key);
    tx.db.prepare(`UPDATE "requirements" SET "status" = 'pending' WHERE "project" = ? AND "key" = ? AND "status" = 'approved'`).run(args.project, q.key);
  }
}

// The adopted tests every applied protected proposal of the project
// declared (D6 §8.3; B13): their dependency boundaries stay in force.
export function appliedAdoptedTests(db: Db, project: string): unknown[] {
  const rows = db.prepare(`SELECT "adopted_tests" FROM "protected_proposals" WHERE "project" = ? AND "status" = 'applied' AND "adopted_tests" IS NOT NULL ORDER BY "seq"`).all(project) as { adopted_tests: string }[];
  return rows.flatMap((r) => parseJson<unknown[]>(r.adopted_tests) ?? []);
}

// A policy revision committed (store/transitions/finalize.ts): the open
// retrofit questions bind it, so each is raised in its next generation in
// the same transaction, never left stale for the owner to answer.
export function reraiseOnPolicy(tx: Tx, project: string): void {
  if (!isAdopted(tx.db, project)) return;
  const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" IN ('adoption_mode', 'requirement_confirm') AND "status" = 'open' ORDER BY "seq"`).all(project) as DecisionRow[];
  for (const d of open) {
    const next = raiseQuestion(tx, { project, kind: d.kind, subjectType: d.subject_type, subjectId: d.subject_id, scope: d.scope });
    if (next && next.id !== d.id && d.batch_key) tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "id" = ?').run(d.batch_key, next.id);
  }
}

// Every project's repository path (Q1: one project per repository).
export function projectRepositories(db: Db): { id: string; name: string; dev_repo_path: string }[] {
  return db.prepare('SELECT "id", "name", "dev_repo_path" FROM "projects" ORDER BY "created_at"').all() as { id: string; name: string; dev_repo_path: string }[];
}
