// The classifier, the store's side (D3 §§1.6, 3.1 to 3.4, A.3, A.7; B02,
// N01, T10, Q5, K8, L5; SEAM.md §§215 to 218): the classification of a
// captured proposal, recorded at a tick after its capture and never in the
// capturing transaction; a Reviewer's approval under `classifier_authority`;
// and the revalidation of an application's whole binding immediately before
// it begins and when it is replayed.
//
// What the classifier reads of git (the two trees' discoveries and entries)
// is read on the main thread (checks/classify-inputs.ts) and handed in; the
// classification itself is computed here, against the requirement index as
// it stands in the transaction that records it.

import { type AuthoritySetting, type Classified, type ClassifiedKind, DEFAULT_AUTHORITY, authorityInForce, classify, runningClassifierVersion } from '../../checks/classify.js';
import type { ClassifyInputs } from '../../checks/classify-inputs.js';
import type { Discovery } from '../../checks/discovery.js';
import { specRevision } from './baseline.js';
import { knownCriteria } from './checks.js';
import { canonical, sha256 } from './common.js';
import type { DecisionKind } from './decisions.js';
import { refuseOperation, opDetail } from './journal.js';
import { CORRECTION_KIND, type ProposalRow, approveProposal, effectiveVersion, getProposal } from './protected.js';
import { type Facts, correctionManifest, invalidateIntent, raiseQuestion } from './queue.js';
import { engineSettings } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// What the engine records on a proposal it classified (D3 A.3; SEAM.md §216).
export interface StoredClassification extends Classified {
  effective_version: string;
  spec_revision: string;
  classifier_version: number;
  // The setting as it is in force (SEAM.md §217): `authoritative` only when
  // it names the running classifier.
  classifier_authority: 'recommend' | 'authoritative';
  // The discovery of the proposal's tree, frozen (D3 §1.4): the new
  // version's checks when it is applied.
  discovery: Discovery;
}

// The configured setting (A.7), as the store was handed it at open.
export const configuredAuthority = (): AuthoritySetting => {
  try {
    return engineSettings().classifier_authority ?? DEFAULT_AUTHORITY;
  } catch {
    return DEFAULT_AUTHORITY;
  }
};

export const authorityNow = (): 'recommend' | 'authoritative' => authorityInForce(configuredAuthority(), runningClassifierVersion());

// The proposal's classification column, parsed.
function classificationJson(db: Db, proposal: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT "classification" FROM "protected_proposals" WHERE "id" = ?').get(proposal) as { classification: string | null } | undefined;
  return row?.classification ? (JSON.parse(row.classification) as Record<string, unknown>) : null;
}

// Whether the engine's classifier gave the proposal its class. A class the
// harness fixture set (SEAM.md §§67, 215) is not the engine's: the fixture
// replaces the column with the discovery alone, so the class stands and is
// never classified again by the engine (the driver's ruling 1).
export const engineClassified = (json: Record<string, unknown> | null): boolean => typeof json?.classifier_version === 'number';

// A value that differs whenever the discovery does (SEAM.md §218; its form
// is not pinned).
export const discoveryHash = (d: Discovery | null | undefined): string | null => (d ? sha256(canonical(d)) : null);

function buildClassification(tx: Tx, project: string, effective: string, inputs: ClassifyInputs): StoredClassification {
  const c = classify(inputs.p0, inputs.p1, knownCriteria(tx.db, project));
  return {
    ...c,
    effective_version: effective,
    spec_revision: specRevision(tx.db, project),
    classifier_version: runningClassifierVersion(),
    classifier_authority: authorityNow(),
    discovery: inputs.p1.discovery,
  };
}

function writeClassification(tx: Tx, p: ProposalRow, c: StoredClassification): void {
  tx.db
    .prepare('UPDATE "protected_proposals" SET "classification" = ?, "affected_checks" = ?, "classified_change_kind" = ? WHERE "id" = ?')
    .run(JSON.stringify(c), JSON.stringify(c.affected_checks), c.change_kind, p.id);
}

// ---- classification at a tick after the capture (D3 §1.6; SEAM.md §215) --------------------

export interface Unclassified {
  proposal: string;
  repo: string;
  effective: string;
  revision: string;
  tree: string;
}

// The project's captured proposals with no class, with what the main thread
// reads to classify them. A proposal whose effective version records no
// authorized commit cannot be compared with it (a store made before slice
// 17 that holds no exact record): it stays captured, never guessed.
export function unclassifiedProposals(db: Db, args: { project: string }): Unclassified[] {
  const effective = effectiveVersion(db, args.project);
  if (!effective || effective.authorized_revision === null) return [];
  const rows = db
    .prepare(
      `SELECT p."id", p."tree_id", r."dev_repo_path" FROM "protected_proposals" p JOIN "projects" r ON r."id" = p."project"
       WHERE p."project" = ? AND p."status" = 'captured' AND p."classified_change_kind" IS NULL ORDER BY p."seq"`,
    )
    .all(args.project) as { id: string; tree_id: string; dev_repo_path: string }[];
  return rows.map((r) => ({ proposal: r.id, repo: r.dev_repo_path, effective: effective.id, revision: effective.authorized_revision!, tree: r.tree_id }));
}

// The engine's classification of a captured proposal: recorded, routed as
// SEAM.md §69 says (a tightening `classified`, anything else
// `awaiting_human`), and the human's question of its class raised. Only
// while the proposal is still captured with no class and the effective
// version is the one read: otherwise nothing is written, and a later tick
// reads again.
//
// Not built (accepted, D3 §3.3): a proposal classified and not yet approved
// is not classified again when the effective version or the running
// classifier changes; its stored class stands until the revalidation at the
// application, which reads both again.
export function recordClassification(tx: Tx, args: { proposal: string; effective: string; inputs: ClassifyInputs }): { proposal: string; change_kind: ClassifiedKind } | null {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'captured' || p.classified_change_kind !== null) return null;
  if (effectiveVersion(tx.db, p.project)?.id !== args.effective) return null;
  const c = buildClassification(tx, p.project, args.effective, args.inputs);
  const status = c.change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  writeClassification(tx, p, c);
  tx.db.prepare('UPDATE "protected_proposals" SET "status" = ? WHERE "id" = ?').run(status, p.id);
  tx.emit('protected.classified', { project: p.project, proposal: p.id }, { change_kind: c.change_kind, from: p.status, to: status, classifier_version: c.classifier_version });
  raiseQuestion(tx, { project: p.project, kind: CORRECTION_KIND[c.change_kind] as DecisionKind, subjectType: 'protected_proposal', subjectId: p.id });
  return { proposal: p.id, change_kind: c.change_kind };
}

// ---- a Reviewer's approval (E13; D3 §3.3; Q5; SEAM.md §§121, 218) -------------------------------

// A Reviewer's run "approves" a proposal. Under `classifier_authority`
// `authoritative` naming the running classifier, its approval of a
// classified tightening is recorded as the approval, bound to the
// correction manifest as it now stands, and the ticks after apply it once
// that binding is revalidated. Otherwise (K8) it is a recommendation,
// recorded on the proposal, applying nothing: the human's question stays
// open. A Reviewer's approval of anything else is not recorded.
export function reviewerApprove(tx: Tx, args: { proposal: string; run: string }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'classified' || p.classified_change_kind !== 'tightening') return false;
  if (authorityNow() === 'authoritative') {
    approveProposal(tx, p, args.run, 'reviewer');
    const binding = correctionManifest(tx, p.id);
    tx.db.prepare('UPDATE "protected_proposals" SET "approval_binding" = ? WHERE "id" = ?').run(JSON.stringify(binding), p.id);
    return true;
  }
  const row = tx.db.prepare('SELECT "recommendations" FROM "protected_proposals" WHERE "id" = ?').get(p.id) as { recommendations: string };
  const list = JSON.parse(row.recommendations) as { run: string }[];
  if (list.some((r) => r.run === args.run)) return false;
  list.push({ run: args.run, authority: 'reviewer', recommends: 'approve', at: tx.at } as { run: string });
  tx.db.prepare('UPDATE "protected_proposals" SET "recommendations" = ? WHERE "id" = ?').run(JSON.stringify(list), p.id);
  return true;
}

// ---- revalidation of the binding (D3 §3.3; K8; T10; SEAM.md §218) --------------------------------

// The facts the binding is read with now: the head the main thread read,
// and the class and discovery the classifier gives again. A class the
// fixture set stands for the class (ruling 1); the discovery is read again
// whoever classified.
function freshFacts(tx: Tx, p: ProposalRow, inputs: ClassifyInputs | null | undefined, head: string | null | undefined): { facts: Facts; fresh: StoredClassification | null } {
  const facts: Facts = head === undefined ? {} : { head };
  const eff = effectiveVersion(tx.db, p.project);
  if (!inputs || !eff) return { facts, fresh: null };
  const fresh = buildClassification(tx, p.project, eff.id, inputs);
  const mine = engineClassified(classificationJson(tx.db, p.id));
  return { facts: { ...facts, classification: mine ? fresh.change_kind : p.classified_change_kind, discovery: fresh.discovery }, fresh };
}

// What was read again is kept, so the next generation of the human's
// question shows it: the engine's classification replaced whole; under a
// fixture's class, its discovery only.
function keepFresh(tx: Tx, p: ProposalRow, fresh: StoredClassification | null): void {
  if (fresh === null) return;
  const json = classificationJson(tx.db, p.id);
  if (engineClassified(json)) writeClassification(tx, p, fresh);
  else tx.db.prepare('UPDATE "protected_proposals" SET "classification" = ? WHERE "id" = ?').run(JSON.stringify({ ...(json ?? {}), discovery: fresh.discovery }), p.id);
}

// Does the application's binding still hold? The human's binding is its
// intent's preconditions (the manifest at the answer); a Reviewer's, the
// manifest at its approval, and, for a Reviewer, the authority must still
// be in force (Q5: losing the match stops a pending application).
function bindingHolds(tx: Tx, p: ProposalRow, intent: string | null, facts: Facts): boolean {
  const now = correctionManifest(tx, p.id, facts);
  if (intent !== null) {
    const row = tx.db.prepare('SELECT "preconditions" FROM "effect_intents" WHERE "id" = ?').get(intent) as { preconditions: string } | undefined;
    return row !== undefined && canonical(now) === canonical(JSON.parse(row.preconditions));
  }
  const bound = tx.db.prepare('SELECT "approval_binding" FROM "protected_proposals" WHERE "id" = ?').get(p.id) as { approval_binding: string | null };
  if (bound.approval_binding === null) return false;
  if (authorityNow() !== 'authoritative') return false;
  return canonical(now) === canonical(JSON.parse(bound.approval_binding));
}

// A Reviewer's approval withdrawn: the proposal awaits an approval again,
// and the human's question of its class is open, bound to the inputs as
// they now are (the driver's ruling 5).
export function withdrawReviewerApproval(tx: Tx, proposal: string): void {
  const p = getProposal(tx, proposal);
  if (!p || p.status !== 'approved' || p.approver_authority !== 'reviewer') return;
  const status = p.classified_change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  tx.db
    .prepare('UPDATE "protected_proposals" SET "status" = ?, "approver" = NULL, "approver_authority" = NULL, "approved_at" = NULL, "approval_binding" = NULL WHERE "id" = ?')
    .run(status, p.id);
  const kind = CORRECTION_KIND[p.classified_change_kind ?? ''] as DecisionKind | undefined;
  if (kind) raiseQuestion(tx, { project: p.project, kind, subjectType: 'protected_proposal', subjectId: p.id });
}

// Immediately before an application's journal intent (D1 §10.5; D3 §3.3):
// every bound input read again and the proposal classified again. Any
// difference, the class the same or not, withdraws the approval: the
// human's intent invalidated EFFECT_PRECONDITION_CHANGED with its next
// generation raised, or the Reviewer's approval withdrawn and the human's
// question open. Returns whether the application may begin.
export function revalidateApplication(tx: Tx, args: { proposal: string; intent: string | null; head?: string | null; inputs?: ClassifyInputs | null }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'approved') return false;
  if (args.intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
    if (row?.status !== 'pending') return false;
  }
  const { facts, fresh } = freshFacts(tx, p, args.inputs, args.head);
  if (bindingHolds(tx, p, args.intent, facts)) return true;
  keepFresh(tx, p, fresh);
  if (args.intent !== null) invalidateIntent(tx, args.intent);
  else withdrawReviewerApproval(tx, p.id);
  return false;
}

// The same check before a replayed protected operation's effect (D3 §3.3:
// "a replay after a restart is revalidated the same way"): an operation of
// the application this engine did not itself just intend. A binding that
// no longer holds refuses the operation before any effect; its failure
// withdraws what it was for (queue.effectFailed: the intended version
// removed, the intent invalidated or the Reviewer's approval withdrawn).
// Returns whether the operation may go on.
export function revalidateOperation(tx: Tx, args: { operation: string; inputs: ClassifyInputs | null; incarnation: string }): boolean {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized') return true;
  const inputs = op.inputs as { purpose?: string; proposal?: string; intent?: string | null };
  if (inputs.purpose !== 'protected' || !inputs.proposal) return true;
  const p = getProposal(tx, inputs.proposal);
  if (!p || p.status !== 'approved') return true;
  // The human's intent: named by the branch update's inputs, or, for the
  // application's commit, the intent that operation executes. A Reviewer's
  // application has none.
  const intent =
    inputs.intent ??
    (tx.db.prepare(`SELECT "id" FROM "effect_intents" WHERE "operation" = ? AND "kind" = 'protected_application'`).get(op.id) as { id: string } | undefined)?.id ??
    null;
  if (intent === null && p.approver_authority !== 'reviewer') return true;
  // An intent already done or invalidated is not this check's.
  if (intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(intent) as { status: string } | undefined;
    if (!row || row.status === 'done' || row.status === 'invalidated') return true;
  }
  const { facts, fresh } = freshFacts(tx, p, args.inputs, undefined);
  if (bindingHolds(tx, p, intent, facts)) return true;
  keepFresh(tx, p, fresh);
  refuseOperation(tx, {
    operation: op.id,
    detail: { reason: 'precondition_changed', text: "the protected application's binding changed before its replay: EFFECT_PRECONDITION_CHANGED" },
    incarnation: args.incarnation,
  });
  return false;
}

// What the main thread reads to revalidate an operation's application.
export function operationApplication(db: Db, args: { operation: string }): { proposal: string; repo: string; revision: string | null; tree: string } | null {
  const row = db.prepare('SELECT "finalizer_inputs" FROM "operations" WHERE "id" = ?').get(args.operation) as { finalizer_inputs: string } | undefined;
  if (!row) return null;
  const inputs = JSON.parse(row.finalizer_inputs) as { purpose?: string; proposal?: string };
  if (inputs.purpose !== 'protected' || !inputs.proposal) return null;
  const p = db.prepare('SELECT p."tree_id", p."project", r."dev_repo_path" FROM "protected_proposals" p JOIN "projects" r ON r."id" = p."project" WHERE p."id" = ?').get(inputs.proposal) as
    | { tree_id: string; project: string; dev_repo_path: string }
    | undefined;
  if (!p) return null;
  const eff = effectiveVersion(db, p.project);
  return { proposal: inputs.proposal, repo: p.dev_repo_path, revision: eff?.authorized_revision ?? null, tree: p.tree_id };
}
