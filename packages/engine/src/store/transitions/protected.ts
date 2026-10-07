// The protected path, the store's side (D1 §§2.4, 3.3, 7.3, 7.9; RN R2, R4;
// E13; build spec §6 corrections 3, 5, 14, 17; SEAM.md §§66, 68, 69): the
// protected versions of a project, the proposals that may become one, their
// classification, their approval by a Reviewer, and the application of an
// approved proposal through the journal. The git work (fingerprints, trees,
// commits) is done on the main thread and handed in.

import { Refusal } from '../../refusal.js';
import { illegal, notFound, parseJson } from './common.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { markStale } from './evidence.js';
import { intendCommit } from './accept.js';
import type { IntentResult, IntentSpec } from './journal.js';
import { integrationRef, projectRepoRow } from './repo.js';
import type { Tx } from './tx.js';
import type { Discovery } from '../../checks/discovery.js';
import { cancelSuperseded, registerAtApplication, writeVersionDiscovery } from './checks.js';

type Db = Tx['db'];

export type ChangeKind = 'initial' | 'tightening' | 'loosening' | 'unclassifiable';
export const CHANGE_KINDS: readonly ChangeKind[] = ['tightening', 'loosening', 'unclassifiable'];

export interface VersionRow {
  id: string;
  project: string;
  seq: number;
  fingerprint: string;
  check_ids: string;
  change_kind: ChangeKind;
  proposal: string | null;
  approved_by: string;
  approver_authority: string;
  authorized: number;
  effective_from: string | null;
  superseded_by: string | null;
  roots: string;
  fingerprint_scheme: 'pairs' | 'manifest' | 'unreadable';
  authorized_revision: string | null;
}

export interface ProposalRow {
  id: string;
  project: string;
  seq: number;
  proposed_by: 'verifier_run' | 'human';
  run: string | null;
  base_revision: string;
  tree_id: string;
  diff_hash: string;
  rationale: string | null;
  requested_change_kind: ChangeKind;
  classified_change_kind: ChangeKind | null;
  status: 'captured' | 'classified' | 'awaiting_human' | 'approved' | 'applied' | 'rejected';
  approver: string | null;
  approver_authority: string | null;
  approved_at: string | null;
  resulting_version: string | null;
  changes_required_set: number;
}

export interface ProtectedSet {
  roots: string[];
  fingerprint: string;
  // What discovery read of the tree (D3 §1.4): the version's checks, governed
  // values and errors. Absent where nothing was discovered.
  discovery?: Discovery | null;
}

// The one effective version of a project: authorized, in effect, not
// superseded.
export function effectiveVersion(db: Db, project: string): VersionRow | undefined {
  return db
    .prepare(`SELECT * FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL`)
    .get(project) as VersionRow | undefined;
}

export function mustEffective(db: Db, project: string): VersionRow {
  const v = effectiveVersion(db, project);
  if (!v) throw new Refusal(409, 'illegal_transition', `Project ${project} has no effective protected version.`, 'Create the project again; nothing was changed.', { project });
  return v;
}

export const rootsOfVersion = (v: VersionRow): string[] => JSON.parse(v.roots) as string[];

function nextVersionSeq(tx: Tx, project: string): number {
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "protected_versions" WHERE "project" = ?').get(project) as { n: number };
  return n;
}

// A project's first version, recorded when it is created or installed
// (SEAM.md §66): authorized and effective, with the fingerprint of its
// integration branch's commit under the roots its governed file names.
// `revision`: the commit the set was read at, its authorized tree (Q11).
export function recordInitialVersion(tx: Tx, project: string, set: ProtectedSet, approvedBy: string, revision: string): string {
  const id = tx.newId('pv_');
  tx.db
    .prepare(
      `INSERT INTO "protected_versions" ("id", "created_at", "project", "seq", "fingerprint", "check_ids", "change_kind", "proposal", "approved_by",
         "approver_authority", "approved_at", "authorized", "effective_from", "roots", "fingerprint_scheme", "authorized_revision")
       VALUES (?, ?, ?, 1, ?, '[]', 'initial', NULL, ?, 'human', ?, 1, ?, ?, 'manifest', ?)`,
    )
    .run(id, tx.at, project, set.fingerprint, approvedBy, tx.at, tx.at, JSON.stringify(set.roots), revision);
  if (set.discovery) writeVersionDiscovery(tx, { project, version: id, discovery: set.discovery });
  return id;
}

export function getProposal(tx: Tx, id: string): ProposalRow | undefined {
  return tx.db.prepare('SELECT * FROM "protected_proposals" WHERE "id" = ?').get(id) as ProposalRow | undefined;
}

// ---- capture -------------------------------------------------------------------

export interface CaptureArgs {
  project: string;
  proposedBy: 'verifier_run' | 'human';
  run: string | null;
  base: string;
  tree: string;
  diffHash: string;
  rationale: string | null;
  requested: ChangeKind;
  changesRequiredSet: boolean;
}

// A proposal is recorded, captured: nothing is applied (D1 §7.3 step 2,
// §11.4; SEAM.md §§66, 68).
export function captureProposal(tx: Tx, args: CaptureArgs, label: Record<string, unknown> = {}): ProposalRow {
  const id = tx.newId('prop_');
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "protected_proposals" WHERE "project" = ?').get(args.project) as { n: number };
  tx.db
    .prepare(
      `INSERT INTO "protected_proposals" ("id", "created_at", "project", "seq", "proposed_by", "run", "base_revision", "tree_id", "diff_hash", "affected_checks",
         "rationale", "requested_change_kind", "status", "changes_required_set")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'captured', ?)`,
    )
    .run(id, tx.at, args.project, n, args.proposedBy, args.run, args.base, args.tree, args.diffHash, args.rationale, args.requested, args.changesRequiredSet ? 1 : 0);
  tx.emit('protected.proposed', { project: args.project, proposal: id, run: args.run }, { ...label, proposed_by: args.proposedBy, requested_change_kind: args.requested, tree: args.tree });
  return getProposal(tx, id)!;
}

// ---- classification and approval ------------------------------------------------

export const CORRECTION_KIND: Record<string, string> = {
  tightening: 'check_correction_tightening',
  loosening: 'check_correction_loosening',
  unclassifiable: 'check_correction_unclassifiable',
};

export function openCorrectionDecisions(tx: Tx, proposal: string): DecisionRow[] {
  return tx.db
    .prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open' AND "kind" LIKE 'check_correction_%'`)
    .all(proposal) as DecisionRow[];
}

// What D3's classifier would say of a proposal, as a fixture (SEAM.md §§67,
// 69): the proposal is classified, and routed. A classification replaced
// before approval closes the decision of the old class. The decision of the
// new class is raised by the caller (the attention queue).
export function classifyProposal(tx: Tx, args: { proposal: string; changeKind: ChangeKind }, label: Record<string, unknown>): ProposalRow {
  const p = getProposal(tx, args.proposal);
  if (!p) throw notFound('proposal', args.proposal);
  if (p.status === 'approved') {
    // The classifier run again on an approved proposal before its
    // application (D2 §5 C2, K8: classification is an effect precondition):
    // its answer is recorded, and the application's precondition read
    // finds it.
    tx.db.prepare('UPDATE "protected_proposals" SET "classified_change_kind" = ? WHERE "id" = ?').run(args.changeKind, p.id);
    tx.emit('protected.classified', { project: p.project, proposal: p.id }, { ...label, change_kind: args.changeKind, from: p.status, to: p.status });
    return getProposal(tx, p.id)!;
  }
  if (!['captured', 'classified', 'awaiting_human'].includes(p.status)) throw illegal(`Classifying a ${p.status} proposal`, { proposal: p.id, status: p.status });
  const status = args.changeKind === 'tightening' ? 'classified' : 'awaiting_human';
  tx.db.prepare('UPDATE "protected_proposals" SET "classified_change_kind" = ?, "status" = ? WHERE "id" = ?').run(args.changeKind, status, p.id);
  for (const d of openCorrectionDecisions(tx, p.id)) if (d.kind !== CORRECTION_KIND[args.changeKind]) invalidateDecision(tx, d, 'the proposal was classified again');
  tx.emit('protected.classified', { project: p.project, proposal: p.id }, { ...label, change_kind: args.changeKind, from: p.status, to: status });
  return getProposal(tx, p.id)!;
}

// An approval is recorded on the proposal (E13): the human's, in the
// transaction that consumes the decision, or a Reviewer's run's.
export function approveProposal(tx: Tx, p: ProposalRow, approver: string, authority: 'reviewer' | 'human'): void {
  tx.db
    .prepare(`UPDATE "protected_proposals" SET "status" = 'approved', "approver" = ?, "approver_authority" = ?, "approved_at" = ? WHERE "id" = ?`)
    .run(approver, authority, tx.at, p.id);
  tx.emit('protected.approved', { project: p.project, proposal: p.id }, { approver, authority, from: p.status });
}

// A Reviewer's run "approves" a proposal (E13; D2 §5 C2, K8): until D3's
// classifier is qualified, the approval of a tightening is a recommendation,
// recorded on the proposal and applying nothing: the proposal stays
// unapplied, the effective version unchanged, and the human's
// check_correction_tightening question open. A Reviewer's approval of
// anything else is not even recorded.
export function reviewerApprove(tx: Tx, args: { proposal: string; run: string }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'classified' || p.classified_change_kind !== 'tightening') return false;
  const row = tx.db.prepare('SELECT "recommendations" FROM "protected_proposals" WHERE "id" = ?').get(p.id) as { recommendations: string };
  const list = JSON.parse(row.recommendations) as { run: string }[];
  if (list.some((r) => r.run === args.run)) return false;
  list.push({ run: args.run, authority: 'reviewer', recommends: 'approve', at: tx.at } as { run: string });
  tx.db.prepare('UPDATE "protected_proposals" SET "recommendations" = ? WHERE "id" = ?').run(JSON.stringify(list), p.id);
  return true;
}

// An approval whose effect was invalidated is withdrawn: the proposal awaits
// an approval again (E34 item 8; SEAM.md §76).
export function withdrawApproval(tx: Tx, proposal: string): void {
  const p = getProposal(tx, proposal);
  if (!p || p.status !== 'approved') return;
  const status = p.classified_change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  tx.db.prepare('UPDATE "protected_proposals" SET "status" = ?, "approver" = NULL, "approver_authority" = NULL, "approved_at" = NULL WHERE "id" = ?').run(status, p.id);
}

// ---- application ----------------------------------------------------------------

export interface ApplicationFacts {
  project: string;
  repo: string;
  ref: string;
  head: string | null;
  proposal: ProposalRow;
  effective: VersionRow;
  pending: string | null;
}

// What the main thread needs to prepare an application.
export function applicationFacts(tx: Tx, args: { proposal: string }): ApplicationFacts {
  const p = getProposal(tx, args.proposal);
  if (!p) throw notFound('proposal', args.proposal);
  const r = projectRepoRow(tx, p.project);
  const ref = integrationRef(r.integration_branch);
  const head = tx.db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(p.project, ref) as { expected_oid: string } | undefined;
  const pending = tx.db.prepare('SELECT "id" FROM "protected_versions" WHERE "proposal" = ?').get(p.id) as { id: string } | undefined;
  return { project: p.project, repo: r.dev_repo_path, ref, head: head?.expected_oid ?? null, proposal: p, effective: mustEffective(tx.db, p.project), pending: pending?.id ?? null };
}

export interface ApplicationInputs {
  purpose: 'protected';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  proposal: string;
  version: string;
  intent: string | null;
}

// The application begins (SEAM.md §69): one transaction records the
// intended version, unauthorized, together with the journal intent of the
// commit, whose finalizer intends the ref update, whose finalizer in turn
// authorizes the version. Returns null if there is nothing to apply.
export function beginApplication(
  tx: Tx,
  args: { proposal: string; repo: string; head: string; tree: string; sha: string; content: string; set: ProtectedSet; intent: string | null; deadlineSeconds: number },
  revalidate: ((tx: Tx) => boolean) | null,
): IntentResult | null {
  const p = getProposal(tx, args.proposal);
  if (!p) throw notFound('proposal', args.proposal);
  const existing = tx.db.prepare('SELECT "id" FROM "protected_versions" WHERE "proposal" = ?').get(p.id) as { id: string } | undefined;
  if (existing) {
    const op = tx.db
      .prepare(`SELECT "id" FROM "operations" WHERE "kind" = 'git_commit' AND json_extract("finalizer_inputs", '$.purpose') = 'protected' AND json_extract("finalizer_inputs", '$.proposal') = ?`)
      .get(p.id) as { id: string } | undefined;
    return op ? { operation: op.id, existing: true } : null;
  }
  if (p.status !== 'approved') return null;
  if (revalidate && !revalidate(tx)) return null;
  const r = projectRepoRow(tx, p.project);
  const ref = integrationRef(r.integration_branch);
  const version = tx.newId('pv_');
  tx.db
    .prepare(
      `INSERT INTO "protected_versions" ("id", "created_at", "project", "seq", "fingerprint", "check_ids", "change_kind", "proposal", "approved_by",
         "approver_authority", "approved_at", "authorized", "effective_from", "roots", "fingerprint_scheme", "authorized_revision")
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 0, NULL, ?, 'manifest', ?)`,
    )
    .run(
      version,
      tx.at,
      p.project,
      nextVersionSeq(tx, p.project),
      args.set.fingerprint,
      p.classified_change_kind ?? p.requested_change_kind,
      p.id,
      p.approver ?? 'unknown',
      p.approver_authority ?? 'human',
      p.approved_at ?? tx.at,
      JSON.stringify(args.set.roots),
      args.sha,
    );
  // The discovery frozen for the proposal, the new version's checks (D3 §1.4).
  if (args.set.discovery) writeVersionDiscovery(tx, { project: p.project, version, discovery: args.set.discovery });
  const inputs: ApplicationInputs = { purpose: 'protected', ref, ref_kind: 'integration', new_oid: args.sha, proposal: p.id, version, intent: args.intent };
  const follow: IntentSpec = {
    project: p.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: args.head, new_oid: args.sha },
    target: { repo: args.repo, ref },
    subject: { proposal: p.id, new_oid: args.sha },
    finalizer: inputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
  };
  const made = intendCommit(tx, {
    project: p.project,
    repo: args.repo,
    purpose: 'protected',
    tree: args.tree,
    parent: args.head,
    sha: args.sha,
    content: args.content,
    revisionKind: 'protected',
    follow,
    deadlineSeconds: args.deadlineSeconds,
    extra: { proposal: p.id, version },
  });
  if ('operation' in made && args.intent !== null) {
    tx.db.prepare(`UPDATE "effect_intents" SET "status" = 'executing', "operation" = ? WHERE "id" = ? AND "status" = 'pending'`).run(made.operation, args.intent);
    tx.emit('intent.executing', { project: p.project, intent: args.intent, operation: made.operation }, { kind: 'protected_application' });
  }
  return made;
}

// The integration branch is at the applied commit: the finalizer of the
// application (SEAM.md §69), in one transaction.
export function finalizeApplication(tx: Tx, op: { id: string; project: string }, inputs: ApplicationInputs): Record<string, unknown> {
  const v = tx.db.prepare('SELECT * FROM "protected_versions" WHERE "id" = ?').get(inputs.version) as VersionRow;
  if (v.authorized === 1) return { version: v.id };
  const previous = effectiveVersion(tx.db, op.project);
  // The previous version is superseded before the new one takes effect:
  // exactly one is effective at every moment.
  if (previous && previous.id !== v.id) tx.db.prepare('UPDATE "protected_versions" SET "superseded_by" = ? WHERE "id" = ?').run(v.id, previous.id);
  tx.db.prepare('UPDATE "protected_versions" SET "authorized" = 1, "effective_from" = ?, "applied_by_operation" = ? WHERE "id" = ?').run(tx.at, op.id, v.id);
  tx.db.prepare(`UPDATE "protected_proposals" SET "status" = 'applied', "resulting_version" = ? WHERE "id" = ?`).run(v.id, inputs.proposal);
  // The evidence that depended on the old version (SEAM.md §72).
  if (previous) {
    const results = (tx.db.prepare('SELECT "id" FROM "check_results" WHERE "project" = ? AND "protected_version" = ? AND "invalidated_at" IS NULL').all(op.project, previous.id) as { id: string }[]).map((r) => r.id);
    invalidateResults(tx, op.project, results, 'protected_version_superseded');
  }
  markStale(tx, { project: op.project });
  if (inputs.intent) completeIntent(tx, inputs.intent);
  // The new version's checks, registered in the transaction that invalidates
  // the old results (D3 §2.5, §3.5; L2).
  registerAtApplication(tx, { project: op.project, proposal: inputs.proposal, version: v.id });
  // Queued executions of the superseded version never launch (T15).
  cancelSuperseded(tx, op.project);
  tx.emit('protected.applied', { project: op.project, proposal: inputs.proposal, version: v.id }, { operation: op.id, previous: previous?.id ?? null, revision: inputs.new_oid });
  return { version: v.id };
}

export function completeIntent(tx: Tx, intent: string): void {
  const row = tx.db.prepare('SELECT "id", "project", "status", "operation" FROM "effect_intents" WHERE "id" = ?').get(intent) as
    | { id: string; project: string; status: string; operation: string | null }
    | undefined;
  if (!row || row.status === 'done' || row.status === 'invalidated') return;
  tx.db.prepare(`UPDATE "effect_intents" SET "status" = 'done' WHERE "id" = ?`).run(row.id);
  tx.emit('intent.done', { project: row.project, intent: row.id, operation: row.operation }, {});
}

// Check results are invalidated (correction 17): durable, and no other column
// changes. Every evaluation is stale; a finding resolved by one of them is
// open again.
export function invalidateResults(tx: Tx, project: string, ids: string[], why: string): void {
  if (ids.length === 0) return;
  const update = tx.db.prepare('UPDATE "check_results" SET "invalidated_at" = ? WHERE "id" = ? AND "invalidated_at" IS NULL');
  for (const id of ids) update.run(tx.at, id);
  const resolved = tx.db.prepare(`SELECT "id", "resolution_verification" FROM "findings" WHERE "project" = ? AND "status" = 'resolved'`).all(project) as {
    id: string;
    resolution_verification: string | null;
  }[];
  for (const f of resolved) {
    const proof = parseJson<{ check_result: string }>(f.resolution_verification);
    if (!proof || !ids.includes(proof.check_result)) continue;
    tx.db.prepare(`UPDATE "findings" SET "status" = 'open', "resolution_verification" = NULL WHERE "id" = ?`).run(f.id);
    tx.emit('finding.reopened', { project, finding: f.id }, { check_result: proof.check_result, why });
  }
  markStale(tx, { project });
}

// ---- the fingerprint over the manifest (L6) and the Q11 migration -------------------

// Every version whose fingerprint is not over the manifest: recorded under
// the mode-free scheme, or found unreadable at an earlier start (retried at
// each start). With what recomputing it needs: the project's repository,
// the version's roots and the commit it was authorized from.
export function fingerprintsToRecompute(db: Db): { id: string; project: string; repo: string; roots: string[]; fingerprint: string; scheme: string; revision: string | null; authorized: number }[] {
  const rows = db
    .prepare(
      `SELECT v."id", v."project", p."dev_repo_path" AS "repo", v."roots", v."fingerprint", v."fingerprint_scheme" AS "scheme", v."authorized_revision" AS "revision", v."authorized"
       FROM "protected_versions" v JOIN "projects" p ON p."id" = v."project" WHERE v."fingerprint_scheme" <> 'manifest' ORDER BY v."project", v."seq"`,
    )
    .all() as { id: string; project: string; repo: string; roots: string; fingerprint: string; scheme: string; revision: string | null; authorized: number }[];
  return rows.map((r) => ({ ...r, roots: JSON.parse(r.roots) as string[] }));
}

// The migration's outcome for one version (Q11 (a)): its fingerprint over the
// manifest of its authorized tree, or unreadable (`fingerprint` null), the
// value it had kept and compared with nothing. A version already over the
// manifest is never touched.
export function recordRecomputedFingerprint(tx: Tx, args: { version: string; fingerprint: string | null; why: string | null }): void {
  const v = tx.db.prepare('SELECT * FROM "protected_versions" WHERE "id" = ?').get(args.version) as VersionRow | undefined;
  if (!v || v.fingerprint_scheme === 'manifest') return;
  if (args.fingerprint !== null) {
    tx.db.prepare(`UPDATE "protected_versions" SET "fingerprint" = ?, "fingerprint_scheme" = 'manifest' WHERE "id" = ?`).run(args.fingerprint, v.id);
  } else if (v.fingerprint_scheme !== 'unreadable') {
    tx.db.prepare(`UPDATE "protected_versions" SET "fingerprint_scheme" = 'unreadable' WHERE "id" = ?`).run(v.id);
  } else return;
  tx.emit(
    'protected.fingerprint_recomputed',
    { project: v.project, version: v.id },
    { from_scheme: v.fingerprint_scheme, scheme: args.fingerprint === null ? 'unreadable' : 'manifest', fingerprint: args.fingerprint, why: args.why },
  );
}

// The harness's legacy fingerprint fixture (SEAM.md §197): what to compute
// it from, and its recording.
export function versionSource(db: Db, version: string): { repo: string; roots: string[]; revision: string | null } | null {
  const r = db
    .prepare(`SELECT p."dev_repo_path" AS "repo", v."roots", v."authorized_revision" AS "revision" FROM "protected_versions" v JOIN "projects" p ON p."id" = v."project" WHERE v."id" = ?`)
    .get(version) as { repo: string; roots: string; revision: string | null } | undefined;
  return r ? { repo: r.repo, roots: JSON.parse(r.roots) as string[], revision: r.revision } : null;
}

export function recordLegacyFingerprint(tx: Tx, args: { version: string; fingerprint: string }): { protected_version: { id: string; fingerprint: string } } {
  tx.db.prepare(`UPDATE "protected_versions" SET "fingerprint" = ?, "fingerprint_scheme" = 'pairs' WHERE "id" = ?`).run(args.fingerprint, args.version);
  return { protected_version: { id: args.version, fingerprint: args.fingerprint } };
}
